// Shared helpers for vendoring third-party GitHub Actions.
// Manifest: ../vendor-manifest.yml (parsed with `yq`, which GitHub-hosted runners ship).
// No npm dependencies: node >= 20, git, tar, yq.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_FILE = "vendor-manifest.yml";
export const MANIFEST_PATH = join(ROOT, MANIFEST_FILE);

// Files every vendored tree keeps regardless of exclude patterns.
// .github/*.json files are problem matchers and release manifests that actions load at run time
// (astral-sh/setup-uv registers .github/python.json via ::add-matcher), so they are never excluded.
export const ALWAYS_KEEP = ["action.yml", "action.yaml", "**/LICENSE*", "**/LICENCE*", "**/NOTICE*", "**/COPYING*", "package.json", ".vendored.json", ".github/*.json"];

export const NODE_BUILTINS = new Set(["assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "sys", "test", "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib"]);

export class VendorError extends Error {}

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.error) throw new VendorError(`${cmd} not found or failed to start: ${r.error.message}`);
  if (r.status !== 0) throw new VendorError(`${cmd} ${args.join(" ")} failed (${r.status}): ${r.stderr?.trim()}`);
  return r.stdout;
}

export function yqJson(file, expr = ".") {
  try { return JSON.parse(sh("yq", ["-o=json", expr, file])); }
  catch (e) { throw new VendorError(`could not parse ${file} with yq (install: brew install yq): ${e.message}`); }
}
export function yqJsonFromString(text, expr = ".") {
  const r = spawnSync("yq", ["-o=json", expr], { input: text, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new VendorError(`yq failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

export function loadManifest(path = MANIFEST_PATH) {
  if (!existsSync(path)) throw new VendorError(`${path} not found`);
  const m = yqJson(path);
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new VendorError(`${path}: expected a mapping with an actions list`);
  m.org ??= "wevm/actions";
  m.vendor_dir ??= "vendor";
  m.default_exclude ??= [];
  m.allowed_upstreams ??= [];
  m.actions ??= [];
  if (!/^[0-9a-f]{40}$/.test(m.self_sha ?? "") || !m.self_tag) {
    throw new VendorError(`${path}: self_sha and self_tag must identify a published commit`);
  }
  const names = new Set();
  for (const a of m.actions) {
    if (!/^[\w-][\w.-]*\/[\w-][\w.-]*(?:\/[\w-][\w.-]*)?$/.test(a.name ?? "")) throw new VendorError(`manifest entry with bad name: ${JSON.stringify(a.name)}`);
    if ([...names].some((name) => name === a.name || name.startsWith(`${a.name}/`) || a.name.startsWith(`${name}/`))) {
      throw new VendorError(`duplicate or overlapping manifest entry: ${a.name}`);
    }
    names.add(a.name);
    a.upstream ??= a.name.split("/").slice(0, 2).join("/");
    if (!/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(a.upstream)) throw new VendorError(`${a.name}: invalid upstream repository`);
    if (!/^[0-9a-f]{40}$/.test(a.sha ?? "")) throw new VendorError(`${a.name}: sha must be a full 40-hex commit`);
    if (!a.ref) throw new VendorError(`${a.name}: ref is required`);
    if (a.strip_dev_dependencies !== undefined && typeof a.strip_dev_dependencies !== "boolean") {
      throw new VendorError(`${a.name}: strip_dev_dependencies must be a boolean`);
    }
    if (a.security_patches !== undefined && (!Array.isArray(a.security_patches) || a.security_patches.some((path) => typeof path !== "string" || !/^vendor\/patches\/[\w.-]+\.patch$/.test(path)))) {
      throw new VendorError(`${a.name}: security_patches must list files under vendor/patches/`);
    }
    a.exclude ??= []; a.keep ??= []; a.pin_nested ??= {};
  }
  return m;
}

// ---------- glob matching (anchored at the vendored tree root; `**/` for any depth) ----------
export function globToRegExp(glob) {
  let g = glob.trim();
  const dirOnly = g.endsWith("/");
  if (dirOnly) g = g.slice(0, -1);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A pattern matches the path itself and, when it names a directory, everything below it.
  return new RegExp(`^${re}(?:/.*)?$`);
}
const reCache = new Map();
export function matchesAny(rel, patterns) {
  for (const p of patterns) {
    let re = reCache.get(p);
    if (!re) { re = globToRegExp(p); reCache.set(p, re); }
    if (re.test(rel)) return p;
  }
  return null;
}

export function walk(dir, acc = [], base = dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc, base); else acc.push(relative(base, p).split("\\").join("/"));
  }
  return acc;
}
export function removeEmptyDirs(dir, root = dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) removeEmptyDirs(join(dir, e.name), root);
  if (dir !== root && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
}

// ---------- upstream access ----------
export function upstreamUrl(name) { return `https://github.com/${name}`; }

export function lsRemote(name, ...refs) {
  const out = sh("git", ["ls-remote", upstreamUrl(name), ...refs]);
  return out.split("\n").filter(Boolean).map((l) => { const [sha, ref] = l.split("\t"); return { sha, ref }; });
}
export function lsRemoteAll(name) {
  const out = sh("git", ["ls-remote", "--tags", "--heads", upstreamUrl(name)]);
  return out.split("\n").filter(Boolean).map((l) => { const [sha, ref] = l.split("\t"); return { sha, ref }; });
}

// Resolve a tag/branch/sha to { sha, ref_type, label }.
export function resolveRef(name, ref, remote = lsRemoteAll(name)) {
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const tags = tagsPointingAt(remote, ref);
    if (tags.length) return { sha: ref, ref_type: "tag", label: tags[tags.length - 1] };
    const head = remote.find((r) => r.ref.startsWith("refs/heads/") && r.sha === ref);
    if (head) return { sha: ref, ref_type: "branch", label: head.ref.replace("refs/heads/", "") };
    return { sha: ref, ref_type: "commit", label: ref.slice(0, 12) };
  }
  const peeled = remote.find((r) => r.ref === `refs/tags/${ref}^{}`) ?? remote.find((r) => r.ref === `refs/tags/${ref}`);
  if (peeled) return { sha: peeled.sha, ref_type: "tag", label: ref };
  const head = remote.find((r) => r.ref === `refs/heads/${ref}`);
  if (head) return { sha: head.sha, ref_type: "branch", label: ref };
  throw new VendorError(`${name}: no tag or branch named ${ref}`);
}
export function tagsPointingAt(remote, sha) {
  const peeledNames = new Set(remote.filter((r) => r.ref.endsWith("^{}")).map((r) => r.ref.slice(10, -3)));
  const names = remote.filter((r) => r.sha === sha && r.ref.startsWith("refs/tags/")).map((r) => r.ref.slice(10).replace(/\^\{\}$/, ""))
    // for annotated tags only the peeled entry points at the commit; for lightweight tags the plain entry does
    .filter((n) => !peeledNames.has(n) || remote.some((r) => r.ref === `refs/tags/${n}^{}` && r.sha === sha));
  return [...new Set(names)].sort(compareVersions);
}
export function compareVersions(a, b) {
  const pa = a.replace(/^v/, "").split(/[.-]/), pb = b.replace(/^v/, "").split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "", y = pb[i] ?? "";
    if (x === y) continue;
    const nx = Number(x), ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) return nx - ny;
    return x < y ? -1 : 1;
  }
  return 0;
}

// Older Git versions print UTC as +00:00 for %cI; newer versions use Z.
export function normalizeCommitDate(date) {
  return date.trim().replace(/\+00:00$/, "Z");
}

// Verify the manifest pin still matches upstream (tags only), then extract exactly that commit into dest.
export function fetchUpstream(entry, dest, { verify = true } = {}) {
  const url = upstreamUrl(entry.upstream ?? entry.name);
  const refType = entry.ref_type ?? (/^[0-9a-f]{40}$/.test(entry.ref) ? "commit" : undefined);
  if (verify && refType !== "commit" && refType !== "branch") {
    const remote = lsRemote(entry.upstream ?? entry.name, `refs/tags/${entry.ref}^{}`, `refs/tags/${entry.ref}`, `refs/heads/${entry.ref}`);
    const tag = remote.find((r) => r.ref === `refs/tags/${entry.ref}^{}`) ?? remote.find((r) => r.ref === `refs/tags/${entry.ref}`);
    const branch = remote.find((r) => r.ref === `refs/heads/${entry.ref}`);
    if (!tag && !branch) throw new VendorError(`${entry.name}: upstream has no tag or branch named ${entry.ref}`);
    if (tag && tag.sha !== entry.sha) throw new VendorError(`${entry.name}: tag ${entry.ref} now points at ${tag.sha} but the manifest pins ${entry.sha}. The upstream tag moved; refusing to sync until a human looks.`);
  }
  const tmp = mkdtempSync(join(tmpdir(), "vendor-git-"));
  try {
    sh("git", ["init", "-q", tmp]);
    sh("git", ["-C", tmp, "fetch", "-q", "--depth", "1", url, entry.sha]);
    const date = normalizeCommitDate(sh("git", ["-C", tmp, "log", "-1", "--format=%cI", "FETCH_HEAD"]));
    mkdirSync(dest, { recursive: true });
    sh("sh", ["-c", `git -C "${tmp}" archive FETCH_HEAD | tar -x -C "${dest}"`]);
    return { url, date };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ---------- excludes ----------
export function applyExcludes(dest, entry, manifest) {
  const keep = [...ALWAYS_KEEP, ...entry.keep];
  const exclude = [...manifest.default_exclude, ...entry.exclude];
  const removed = [];
  for (const rel of walk(dest)) {
    if (matchesAny(rel, keep)) continue;
    const hit = matchesAny(rel, exclude);
    if (hit) { unlinkSync(join(dest, rel)); removed.push(rel); }
  }
  removeEmptyDirs(dest);
  return removed;
}

export function applyPackageTransforms(dest, entry) {
  if (!entry.strip_dev_dependencies) return [];
  const packagePath = join(dest, "package.json");
  if (!existsSync(packagePath)) {
    throw new VendorError(`${entry.name}: strip_dev_dependencies requires package.json`);
  }
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  if (!("devDependencies" in packageJson)) return [];
  delete packageJson.devDependencies;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  return ["package.json:devDependencies"];
}

export function applySecurityPatches(dest, entry, base = ROOT) {
  return (entry.security_patches ?? []).map((path) => {
    sh("patch", ["--batch", "--forward", "--fuzz=0", "-p1", "-i", resolve(base, path)], { cwd: dest });
    return path;
  });
}

// ---------- nested `uses:` rewriting ----------
const USES_RE = /^(\s*-?\s*uses:\s*)(["']?)([^\s"'#]+)\2(\s*(?:#.*)?)$/gm;
function nestedUses(text) {
  return yqJsonFromString(text, '[.. | select(tag == "!!map") | select(has("uses")) | .uses | select(tag == "!!str") | {"target": ., "line": line}]');
}
export function rewriteUsesText(text, { org, allowedUpstreams, vendored, pinNested, selfSha, selfTag }) {
  const missing = new Set(), unpinned = new Set(), changes = [];
  const lines = new Set(nestedUses(text).map((use) => use.line));
  const out = text.replace(USES_RE, (m, lead, q, target, tail, offset) => {
    // Description examples and run-script heredocs are scalar text, not action dependencies.
    if (!lines.has(text.slice(0, offset + lead.length).split("\n").length)) return m;
    if (/^(\.\/|docker:\/\/)/.test(target) || target.startsWith(`${org}/`)) return m;
    const at = target.indexOf("@");
    const path = at === -1 ? target : target.slice(0, at), ref = at === -1 ? "" : target.slice(at + 1);
    if (allowedUpstreams.some((p) => path.startsWith(p))) {
      const pin = pinNested[target];
      if (!pin && /^[0-9a-f]{40}$/.test(ref)) return m;
      if (!pin) { unpinned.add(target); return m; }
      changes.push(`${target} -> ${path}@${pin}`);
      return `${lead}${path}@${pin} # ${target}`;
    }
    const repo = path.split("/").slice(0, 2).join("/");
    if (!vendored.has(repo)) { missing.add(target); return m; }
    const pinned = `${org}/vendor/${path}@${selfSha}`;
    changes.push(`${target} -> ${pinned}`);
    return `${lead}${pinned} # ${selfTag}`;
  });
  return { text: out, missing: [...missing], unpinned: [...unpinned], changes };
}
export function rewriteUsesInTree(dest, entry, manifest) {
  const vendored = new Set(manifest.actions.map((a) => a.name));
  const all = { missing: [], unpinned: [], changes: [] };
  for (const rel of walk(dest).filter((p) => /(^|\/)action\.ya?ml$/.test(p))) {
    const file = join(dest, rel);
    const r = rewriteUsesText(readFileSync(file, "utf8"), { org: manifest.org, allowedUpstreams: manifest.allowed_upstreams, vendored, pinNested: entry.pin_nested, selfSha: manifest.self_sha, selfTag: manifest.self_tag });
    if (r.changes.length) writeFileSync(file, r.text);
    all.missing.push(...r.missing.map((t) => `${rel}: ${t}`)); all.unpinned.push(...r.unpinned.map((t) => `${rel}: ${t}`)); all.changes.push(...r.changes);
  }
  return all;
}

// Nested references to look at before rewriting (used by add.mjs to plan dependencies and pins).
export function collectNestedUses(dest) {
  const found = [];
  for (const rel of walk(dest).filter((p) => /(^|\/)action\.ya?ml$/.test(p) && !p.startsWith(".github/"))) {
    for (const { target } of nestedUses(readFileSync(join(dest, rel), "utf8"))) found.push({ file: rel, target });
  }
  return found;
}

// ---------- analysis: what does this action load? ----------
// Returns { mode, exclude, keep, notes, entryFiles } where mode is "analyzed" or "conservative".
const KNOWN_SAFE_DIRS = ["src/", "lib/", "__tests__/", "__test__/", "test/", "tests/", "spec/", "__fixtures__/", "__mocks__/", "__snapshots__/", "e2e/", "examples/", "example/", "assets/", "images/", "img/", "media/", "screenshots/", "coverage/", ".nyc_output/", "benchmark/", "benchmarks/", ".circleci/", ".yarn/", "node_modules/", "docs/", "doc/", "website/", "site/"];
const KNOWN_SAFE_FILES = ["tsconfig*.json", "jest.config.*", "vitest.config.*", "eslint.config.*", ".eslintrc*", ".eslintignore", ".prettierrc*", ".prettierignore", "babel.config.*", ".babelrc*", "rollup.config.*", "webpack.config.*", "esbuild.config.*", "tsup.config.*", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", ".yarnrc*", ".npmrc", ".nvmrc", ".node-version", ".tool-versions", ".python-version", "justfile", "Taskfile*", ".travis.yml", "appveyor.yml", "azure-pipelines.yml", ".gitlab-ci.yml", "docker-compose*.y*ml", ".dockerignore", "CHANGELOG*", "CHANGES*", "HISTORY*", "CITATION*", ".releaserc*", "release.config.*", ".commitlintrc*", "commitlint.config.*", ".lintstagedrc*", "lint-staged.config.*", ".mocharc*", ".c8rc*", "codecov.yml", ".codecov.yml", "sonar-project.properties", ".deepsource.toml", "mkdocs.yml", "book.toml", "**/*.d.ts", "**/*.test.*", "**/*.spec.*", "**/*.map"];

export function analyzeTree(dest, { subPaths = [] } = {}) {
  const files = walk(dest);
  const top = new Set(files.map((f) => f.split("/")[0]));
  const notes = [];
  const referenced = new Set();      // root-relative first segments (dirs or files) the action loads
  const refPaths = new Set();        // full root-relative paths that were referenced
  const keep = new Set();
  let dynamic = null;                // reason we cannot determine the load set
  let onlyMeta = false;              // nothing in the repo is loaded at run time
  let kind = null, entryFiles = [];

  const actionFiles = ["action.yml", "action.yaml", ...subPaths.flatMap((p) => [`${p}/action.yml`, `${p}/action.yaml`])].filter((f) => files.includes(f));
  if (!actionFiles.length) throw new VendorError(`no action.yml found at repo root${subPaths.length ? ` or under ${subPaths.join(", ")}` : ""}`);
  for (const p of subPaths) keep.add(`${p}/`);

  const addRef = (p) => { const clean = p.replace(/^\.\//, "").replace(/\/$/, ""); const seg = clean.split("/")[0]; if (seg && seg !== "." && seg !== "..") { referenced.add(seg); refPaths.add(clean); } };
  const BUNDLE_MARKERS = /__nccwpck_require__|__webpack_require__|webpackBootstrap|var __create = Object\.create|\/\*! For license information|__toCommonJS|__esbuild/;
  const resolveLiteral = (fromFile, lit) => {
    const target = posix.normalize(posix.join(posix.dirname(fromFile), lit));
    if (target === "." || target === "" || target.startsWith("..")) return { root: true };
    return existsSync(join(dest, target)) ? { rel: target } : null;
  };
  const scanScript = (rel) => {
    const abs = join(dest, rel);
    if (!existsSync(abs) || statSync(abs).isDirectory() || statSync(abs).size > 8 * 1024 * 1024) return new Set();
    const src = readFileSync(abs, "utf8");
    const bundled = BUNDLE_MARKERS.test(src) || src.split("\n").some((l) => l.length > 5000);
    for (const m of src.matchAll(/(?:\$\{\{\s*github\.action_path\s*\}\}|\$\{?GITHUB_ACTION_PATH\}?|\$\{process\.env\.GITHUB_ACTION_PATH\})\/([A-Za-z0-9_.][A-Za-z0-9_./-]*)/g)) addRef(m[1]);
    if (/\$\{?GITHUB_ACTION_PATH\}?(?![\/A-Za-z0-9_])|github\.action_path\s*\}\}(?!\/)/.test(src)) dynamic ??= `${rel} uses the action path dynamically`;
    if (/\.(sh|bash)$/.test(rel) && (/dirname\s+"?\$(?:0|\{?BASH_SOURCE)/.test(src) || /\$\{?BASH_SOURCE/.test(src))) dynamic ??= `${rel} resolves paths from its own location at run time`;
    // relative path literals that escape the file's directory and exist in the tree are loaded; a bare ".." means "the whole tree"
    for (const m of src.matchAll(/["'`](\.\.(?:\/[A-Za-z0-9_][A-Za-z0-9_./-]*)?)["'`]/g)) {
      const r = resolveLiteral(rel, m[1]);
      if (r?.root) { if (!bundled) dynamic ??= `${rel} reads paths relative to the repository root at run time`; }
      else if (r?.rel) addRef(r.rel);
    }
    for (const m of src.matchAll(/__dirname((?:\s*,\s*["'][^"'\n]*["'])+)/g)) {
      const parts = [...m[1].matchAll(/["']([^"'\n]*)["']/g)].map((x) => x[1]);
      const r = resolveLiteral(rel, parts.join("/"));
      if (r?.root) { if (!bundled) dynamic ??= `${rel} reads files relative to __dirname outside its directory`; }
      else if (r?.rel && !r.rel.startsWith(posix.dirname(rel) + "/") && r.rel !== posix.dirname(rel)) addRef(r.rel);
    }
    // bare module imports: only meaningful when the file is not a self-contained bundle
    const bare = new Set();
    if (!bundled) {
      for (const m of src.matchAll(/(?:^|[^\w.$])require\(\s*["']([^"'./][^"']*)["']\s*\)|^\s*(?:import|export)\s[^;\n]*?from\s+["']([^"'./][^"']*)["']|^\s*import\s+["']([^"'./][^"']*)["']/gm)) {
        const spec = (m[1] ?? m[2] ?? m[3]).replace(/^node:/, "").split("/").slice(0, (m[1] ?? m[2] ?? m[3]).startsWith("@") ? 2 : 1).join("/");
        if (!NODE_BUILTINS.has(spec)) bare.add(spec);
      }
    }
    return bare;
  };

  for (const af of actionFiles) {
    const dir = posix.dirname(af) === "." ? "" : posix.dirname(af) + "/";
    const meta = yqJson(join(dest, af));
    const runs = meta?.runs ?? {};
    const using = String(runs.using ?? "");
    if (using.startsWith("node")) {
      kind ??= "node";
      const entries = ["main", "pre", "post"].map((k) => runs[k]).filter(Boolean).map((p) => posix.normalize(dir + p));
      entryFiles.push(...entries);
      const bare = new Set();
      for (const e of entries) { addRef(e); const b = scanScript(e); b?.forEach((x) => bare.add(x)); }
      // sibling files in the entry directory (sourcemap-register.js, licenses.txt) are kept with the directory
      const present = [...bare].filter((p) => existsSync(join(dest, "node_modules", p)));
      if (present.length) { referenced.add("node_modules"); notes.push(`node_modules kept: entry files import ${present.slice(0, 4).join(", ")}${present.length > 4 ? ", …" : ""}`); }
    } else if (using === "composite") {
      kind ??= "composite";
      for (const step of runs.steps ?? []) {
        if (step.uses?.startsWith("./")) addRef(dir + step.uses.slice(2));
        // every string in the step counts: run bodies, env values (PYTHONPATH etc.), with: inputs, working-directory
        const text = JSON.stringify(step).replace(/\\"/g, '"');
        for (const m of text.matchAll(/(?:\$\{\{\s*github\.action_path\s*\}\}|\$\{?GITHUB_ACTION_PATH\}?|\$\{process\.env\.GITHUB_ACTION_PATH\})\/([A-Za-z0-9_.][A-Za-z0-9_./-]*)/g)) addRef(m[1]);
        if (/\$\{?GITHUB_ACTION_PATH\}?(?![\/A-Za-z0-9_])|github\.action_path\s*\}\}(?!\/)/.test(text)) dynamic ??= `${af} uses the action directory itself (working directory, module path or similar)`;
      }
      // follow referenced scripts one level
      for (const r of [...referenced]) {
        const abs = join(dest, r);
        if (!existsSync(abs)) continue;
        if (statSync(abs).isDirectory()) { for (const f of walk(abs).slice(0, 200)) if (/\.(sh|bash|py|js|mjs|cjs|ps1|rb)$/.test(f)) scanScript(posix.join(r, f)); }
        else scanScript(r);
      }
    } else if (using === "docker") {
      kind ??= "docker";
      const image = String(runs.image ?? "");
      if (image.startsWith("docker://")) { onlyMeta = true; notes.push(`runs the prebuilt image ${image}; nothing else in the repo is loaded`); }
      else {
        const dfile = posix.normalize(dir + (image || "Dockerfile"));
        addRef(dfile);
        const df = existsSync(join(dest, dfile)) ? readFileSync(join(dest, dfile), "utf8") : "";
        for (const line of df.split(/\\\r?\n/).join(" ").split("\n")) {
          const m = line.match(/^\s*(COPY|ADD)\s+(.*)$/i);
          if (!m) continue;
          let parts = m[2].trim().startsWith("[") ? JSON.parse(m[2].trim()) : m[2].trim().split(/\s+/);
          parts = parts.filter((p) => !p.startsWith("--"));
          if (parts.some((p) => p.startsWith("--from"))) continue;
          const sources = parts.slice(0, -1);
          for (const s of sources) {
            if (/^(\.|\.\/|\*|\/|\.\/\*)$/.test(s) || /^\*\*?$/.test(s)) dynamic ??= `${dfile} copies the whole build context (${m[1]} ${s})`;
            else if (s.startsWith("http")) continue;
            else addRef(s.replace(/\*.*$/, ""));
          }
        }
        if (!df) dynamic ??= `${dfile} not found in the archive`;
      }
    } else {
      dynamic ??= `unknown runs.using ${JSON.stringify(using)}`;
    }
  }

  // Bundlers and scripts often build paths at run time from fragments the scanners above cannot
  // resolve (for example the aqua config a bundle reads from its own tree). Any top-level entry
  // whose name appears as a path-like string literal in an entry file or referenced script is
  // treated as loaded. False positives only keep files; false negatives would break the action.
  {
    const texts = [];
    const candidates = new Set([...entryFiles, ...referenced]);
    for (const r of candidates) {
      const abs = join(dest, r);
      if (!existsSync(abs)) continue;
      const files = statSync(abs).isDirectory() ? walk(abs).slice(0, 400).map((f) => join(abs, f)) : [abs];
      for (const f of files) { if (statSync(f).size <= 8 * 1024 * 1024 && /\.(c|m)?js$|\.(sh|bash|py|rb|ps1|ya?ml|json)$/.test(f)) texts.push(readFileSync(f, "utf8")); }
    }
    const blob = texts.join("\n");
    for (const t of top) {
      if (referenced.has(t) || matchesAny(t, ALWAYS_KEEP) || /^(\.github|README.*|.*\.md|LICENSE.*|\.git.*|node_modules|dist|src|lib|test|tests|__tests__|docs?)$/.test(t)) continue;
      const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`["'\`](?:\\./)?${esc}(?:/[^"'\`\\s]*)?["'\`]`).test(blob)) { referenced.add(t); notes.push(`${t} kept: named as a path in the code`); }
    }
  }

  if (dynamic) {
    notes.unshift(`whole repository kept (apart from repo-wide defaults): ${dynamic}`);
    return { mode: "conservative", kind, exclude: [], keep: [...keep].sort(), notes, entryFiles, referenced: [...referenced] };
  }
  if (onlyMeta) return { mode: "analyzed", kind, exclude: ["**"], keep: [...keep].sort(), notes, entryFiles, referenced: [] };

  const exclude = [];
  const kept = [];
  const isReferenced = (seg) => referenced.has(seg);
  for (const d of KNOWN_SAFE_DIRS) {
    const seg = d.slice(0, -1);
    if (!top.has(seg)) continue;
    if (isReferenced(seg)) { kept.push(d); continue; }
    if (kind === "node" && (seg === "src" || seg === "lib") && entryFiles.some((e) => e.startsWith(seg + "/"))) { continue; }
    exclude.push(d);
  }
  for (const f of KNOWN_SAFE_FILES) {
    if (!files.some((x) => matchesAny(x, [f]) && !matchesAny(x, [...ALWAYS_KEEP]))) continue;
    if (f === "**/*.map") continue; // handled by repo-wide defaults
    const hitsReferenced = files.filter((x) => matchesAny(x, [f])).some((x) => entryFiles.includes(x) || (kind !== "node" && isReferenced(x.split("/")[0]) && !x.includes("/") === false && false));
    if (hitsReferenced) continue;
    exclude.push(f);
  }
  if (kind === "node") {
    // TypeScript sources are build inputs when every entry point is plain JavaScript
    if (entryFiles.every((e) => /\.(c|m)?js$/.test(e)) && files.some((x) => /\.ts$/.test(x) && !/\.d\.ts$/.test(x) && !matchesAny(x, exclude))) exclude.push("**/*.ts");
    // build-time tooling a Node action never reads while running
    for (const f of ["Dockerfile", "Dockerfile.*", "*.Dockerfile", "docker-bake.hcl", "Makefile", ".dockerignore"]) {
      if (files.some((x) => matchesAny(x, [f])) && ![...referenced].some((r) => matchesAny(r, [f]))) exclude.push(f);
    }
  }
  if (kind === "composite" || kind === "docker") {
    for (const f of ["Makefile", "Dockerfile"]) if (kind === "composite" && top.has(f) && !isReferenced(f)) exclude.push(f);
  }
  // Things at the top level we could not classify stay; say so.
  const unknown = [...top].filter((t) => !referenced.has(t) && !matchesAny(t, [...ALWAYS_KEEP, ...exclude]) && !/^(\.github|README.*|.*\.md|\.gitignore|\.gitattributes|\.editorconfig|CODEOWNERS|renovate\.json.*|\.pre-commit-config\.yaml|\.markdownlint.*|\.yamllint.*|\.mailmap|\.git-blame-ignore-revs|SECURITY.*|CONTRIBUTING.*|CODE_OF_CONDUCT.*|\.husky|\.vscode|\.devcontainer|\.idea|\.changeset|\.git.*)$/.test(t) && !/\.(png|jpe?g|gif|svg|ico|webp)$/i.test(t));
  const dedupe = (arr) => [...new Set(arr)];
  exclude.splice(0, exclude.length, ...dedupe(exclude));
  entryFiles = dedupe(entryFiles);
  // Anything else at the top level is not reachable from the entry points: node bundles only read
  // what they reference by path (checked above), composite steps only what they name, Dockerfiles
  // only what they COPY. List each explicitly so the manifest shows what was dropped.
  const alwaysKept = (t) => matchesAny(t, ALWAYS_KEEP) || [...keep].some((k) => matchesAny(t, [k]));
  for (const t of [...top].sort()) {
    if (referenced.has(t) || alwaysKept(t) || matchesAny(t, exclude)) continue;
    if (unknown.includes(t)) { exclude.push(statSync(join(dest, t)).isDirectory() ? `${t}/` : t); }
  }
  unknown.length = 0;
  // Node bundles laid out as <dir>/<action>/index.js: sibling sub-bundles nobody references are not loaded either.
  if (kind === "node") {
    const tops = new Set(entryFiles.filter((e) => e.split("/").length >= 3).map((e) => e.split("/")[0]));
    for (const t of tops) {
      const tdir = join(dest, t);
      if (!existsSync(tdir) || !statSync(tdir).isDirectory()) continue;
      for (const sub of readdirSync(tdir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
        const prefix = `${t}/${sub}`;
        if ([...refPaths].some((r) => r === prefix || r.startsWith(prefix + "/"))) continue;
        exclude.push(`${prefix}/`);
      }
    }
  }
  const summary = kind === "node" ? `Node action; runs ${entryFiles.join(", ")}.`
    : kind === "composite" ? (referenced.size ? `Composite action; loads ${[...referenced].sort().join(", ")} from the action directory.` : "Composite action; every step is inline, only action.yml is loaded.")
    : `Docker action built from ${entryFiles[0] ?? "Dockerfile"}; copies ${[...referenced].sort().join(", ")}.`;
  notes.unshift(summary);
  if (exclude.length) notes.push(`excluded: ${exclude.join(", ")}`);
  if (kept.length) notes.push(`kept although usually excludable: ${kept.join(", ")} (referenced)`);
  if (kind === "composite" && !referenced.size && !unknown.length) { /* nothing else to exclude */ }
  if (kind === "composite" && !referenced.size) { exclude.length = 0; exclude.push("**"); notes.length = 0; notes.push(summary, "excluded: everything except action.yml and LICENSE"); }
  return { mode: "analyzed", kind, exclude, keep: [...keep].sort(), notes, entryFiles, referenced: [...referenced].sort() };
}

// ---------- provenance + README ----------
export function readmeUrl(name, sha, files) {
  const readme = files.find((f) => /^readme(\.(md|markdown|rst|txt|adoc))?$/i.test(f));
  return readme ? `https://github.com/${name}/blob/${sha}/${readme}` : `https://github.com/${name}`;
}
export function writeStamp(dest, stamp) {
  writeFileSync(join(dest, ".vendored.json"), JSON.stringify(stamp, null, 2) + "\n");
}
export function readStamps(manifest) {
  return manifest.actions.map((a) => {
    const p = join(ROOT, manifest.vendor_dir, a.name, ".vendored.json");
    return existsSync(p) ? { entry: a, stamp: JSON.parse(readFileSync(p, "utf8")) } : { entry: a, stamp: null };
  });
}
export const README_BEGIN = "<!-- vendored-actions:begin -->", README_END = "<!-- vendored-actions:end -->";
export function renderReadmeTable(manifest, stamps) {
  const rows = stamps.map(({ entry, stamp }) => {
    const label = entry.ref_type === "commit" ? `\`${entry.sha.slice(0, 7)}\`` : `${entry.ref} (\`${entry.sha.slice(0, 7)}\`)`;
    const desc = (stamp?.description ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
    return `| [\`${entry.name}\`](${stamp?.readme_url ?? upstreamUrl(entry.upstream ?? entry.name)}) | ${label} | ${desc} |`;
  });
  return [`| Action | Version | Description |`, `|--------|---------|-------------|`, ...rows].join("\n");
}
export function updateReadmeText(text, table) {
  const b = text.indexOf(README_BEGIN), e = text.indexOf(README_END);
  if (b === -1 || e === -1 || e < b) throw new VendorError(`README.md is missing the ${README_BEGIN} / ${README_END} markers`);
  return text.slice(0, b + README_BEGIN.length) + "\n" + table + "\n" + text.slice(e);
}

// yq rewrites the manifest in a compact form: folded `notes: >-` scalars end up on one long line and
// blank lines between entries are dropped. Re-wrap notes at 100 columns (folded scalars join lines
// with a space, so only formatting changes) and separate entries with a blank line.
export function formatManifest(path = MANIFEST_PATH) {
  const lines = readFileSync(path, "utf8").split("\n");
  const out = [];
  let seenEntry = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^  - name: /.test(line)) {
      if (seenEntry && out.length && out[out.length - 1].trim() !== "") out.push("");
      seenEntry = true;
    }
    const m = /^(\s*)notes: >-$/.exec(line);
    if (!m) { out.push(line); continue; }
    out.push(line);
    const ind = m[1] + "  ";
    const buf = [];
    while (i + 1 < lines.length && lines[i + 1].startsWith(ind) && lines[i + 1].trim()) buf.push(lines[++i].trim());
    let cur = "";
    for (const word of buf.join(" ").split(" ")) {
      if (cur && (ind + cur + " " + word).length > 100) { out.push(ind + cur); cur = word; }
      else cur = cur ? `${cur} ${word}` : word;
    }
    if (cur) out.push(ind + cur);
  }
  writeFileSync(path, out.join("\n"));
}
