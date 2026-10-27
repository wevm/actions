#!/usr/bin/env node
// Add a third-party action to vendor-manifest.yml and vendor it.
//
//   node vendor/add.mjs docker/login-action@v3.6.0
//   node vendor/add.mjs dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c --label stable
//   node vendor/add.mjs expo/expo-github-action@v8 --path continuous-deploy-fingerprint
//   flags: --label <text>  human-readable version when the ref is a bare SHA
//          --slot <name>   independent update lane, stored under vendor/<owner>/<repo>/<name>
//          --path <sub>    sub-directory action that is used (repeatable); keeps it if it sits under an excluded dir
//          --notes <text>  extra notes appended to the generated analysis
//          --with-deps     also add nested third-party actions the composite references (at the SHA it pins)
//          --dry-run       print the proposed entry, change nothing
//
// The analysis decides which files can be dropped from the copy. When it cannot tell what the
// action loads at run time, it keeps the whole repository and says why in `notes`.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANIFEST_PATH, MANIFEST_FILE, VendorError, formatManifest, loadManifest, lsRemoteAll, resolveRef, fetchUpstream, analyzeTree, collectNestedUses, sh } from "./lib.mjs";
import { syncEntry, refreshReadme } from "./sync.mjs";

function parseArgs(argv) {
  const o = { paths: [], notes: "", withDeps: false, dryRun: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--label") o.label = argv[++i];
    else if (a === "--slot") o.slot = argv[++i];
    else if (a === "--path") o.paths.push(argv[++i].replace(/^\.?\//, "").replace(/\/$/, ""));
    else if (a === "--notes") o.notes = argv[++i];
    else if (a === "--with-deps") o.withDeps = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--quiet") o.quiet = true;
    else if (a === "--refresh") o.refresh = true;
    else if (!a.startsWith("--") && !o.spec) o.spec = a;
    else throw new VendorError(`unknown argument ${a}`);
  }
  if (o.refresh) { if (!o.spec) throw new VendorError("usage: node vendor/add.mjs --refresh <owner/repo>"); return o; }
  if (!o.spec || !/^[\w.-]+\/[\w.-]+@\S+$/.test(o.spec)) throw new VendorError("usage: node vendor/add.mjs <owner/repo>@<tag|branch|sha> [--label x] [--path sub] [--notes text] [--with-deps] [--dry-run] | --refresh <owner/repo>");
  return o;
}

export function planEntry(name, ref, { label, paths = [], notes = "" } = {}) {
  const remote = lsRemoteAll(name);
  const r = resolveRef(name, ref, remote);
  const entry = { name, ref: label ?? r.label, ref_type: label && /^[0-9a-f]{40}$/.test(ref) ? (r.ref_type === "commit" ? "commit" : r.ref_type) : r.ref_type, sha: r.sha, exclude: [], keep: [], pin_nested: {}, notes: "" };
  if (label && r.ref_type === "commit") entry.ref_type = /^v?\d/.test(label) ? "tag" : "branch";
  if (entry.ref_type === "tag" && label && !remote.some((x) => x.ref === `refs/tags/${label}` || x.ref === `refs/tags/${label}^{}`)) entry.ref_type = "commit"; // label is a hint only
  const tmp = mkdtempSync(join(tmpdir(), "vendor-add-"));
  try {
    fetchUpstream({ ...entry, ref_type: "commit" }, tmp, { verify: false });
    const a = analyzeTree(tmp, { subPaths: paths });
    entry.exclude = a.exclude; entry.keep = a.keep;
    const nested = collectNestedUses(tmp);
    const deps = [], pins = {};
    for (const { target } of nested) {
      if (/^(\.\/|\$\/|docker:\/\/)/.test(target)) continue;
      const at = target.indexOf("@"); const path = at === -1 ? target : target.slice(0, at); const tref = at === -1 ? "" : target.slice(at + 1);
      const repo = path.split("/").slice(0, 2).join("/");
      if (repo === name) continue;
      deps.push({ repo, path, ref: tref, target });
    }
    entry.notes = [...a.notes, notes].filter(Boolean).join(" ");
    return { entry, deps, analysis: a };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

function appendEntry(entry) {
  const tmp = join(tmpdir(), `vendor-entry-${process.pid}.json`);
  const clean = { ...entry };
  if (!Object.keys(clean.pin_nested).length) delete clean.pin_nested;
  if (!clean.keep.length) delete clean.keep;
  writeFileSync(tmp, JSON.stringify(clean));
  try {
    // load() yields flow-style (JSON-looking) nodes; clear the style so the entry is written as block YAML like the rest of the file.
    sh("yq", ["-i", `.actions += [load("${tmp}")] | .actions |= sort_by(.name) | (.actions[] | .. | select(key != null) | key) style="" | (.actions[] | ..) style="" | (.actions[] | .notes) style="folded"`, MANIFEST_PATH]);
  } finally { rmSync(tmp, { force: true }); }
  formatManifest(MANIFEST_PATH);
}

export function addAction(spec, opts, depth = 0) {
  const [upstream, ref] = spec.split("@");
  if (opts.slot && !/^[\w-][\w.-]*$/.test(opts.slot)) throw new VendorError("slot must be a single path segment");
  const name = opts.slot ? `${upstream}/${opts.slot}` : upstream;
  let manifest = loadManifest();
  if (manifest.actions.some((a) => a.name === name)) { console.log(`${name}: already in ${MANIFEST_FILE}, skipping`); return null; }
  const { entry, deps } = planEntry(upstream, ref, opts);
  entry.name = name;
  entry.upstream = upstream;
  // nested third-party actions must be vendored; nested GitHub-authored actions must be SHA-pinned
  for (const d of deps) {
    const allowed = manifest.allowed_upstreams.some((p) => d.path.startsWith(p));
    if (allowed) {
      if (!/^[0-9a-f]{40}$/.test(d.ref)) {
        const r = resolveRef(d.repo, d.ref);
        entry.pin_nested[d.target] = r.sha;
      }
      continue;
    }
    if (!manifest.actions.some((a) => a.name === d.repo)) {
      if (!opts.withDeps) throw new VendorError(`${name} nests ${d.target}, which is not vendored. Re-run with --with-deps, or add ${d.repo} first.`);
      if (depth > 3) throw new VendorError(`dependency chain too deep at ${d.target}`);
      console.log(`${name}: nested dependency ${d.target}, adding it first`);
      addAction(`${d.repo}@${d.ref}`, { ...opts, slot: undefined, label: undefined, paths: [], notes: `Nested dependency of ${name}.` }, depth + 1);
      manifest = loadManifest();
    }
  }
  if (opts.dryRun) { console.log(JSON.stringify(entry, null, 2)); return entry; }
  appendEntry(entry);
  manifest = loadManifest();
  const full = manifest.actions.find((a) => a.name === name);
  const r = syncEntry(full, manifest, join(MANIFEST_PATH, ".."));
  refreshReadme(manifest);
  if (!opts.quiet) console.log(`added ${name}@${entry.ref} (${entry.sha.slice(0, 12)}): ${r.kept} files kept, ${r.removed.length} removed${r.uses.changes.length ? `, ${r.uses.changes.length} nested uses rewritten` : ""}`);
  return full;
}

// Re-run the analysis for an existing entry (after tooling improvements or an upstream restructure),
// keeping its ref/sha/pins, sub-path keeps and any manual sentences in notes.
export function refreshAction(name, opts) {
  const manifest = loadManifest();
  const cur = manifest.actions.find((a) => a.name === name);
  if (!cur) throw new VendorError(`${name} is not in ${MANIFEST_FILE}`);
  const paths = (cur.keep ?? []).filter((k) => k.endsWith("/") && !k.includes("*")).map((k) => k.slice(0, -1));
  const manual = ((cur.notes ?? "").match(/(?:Nested dependency of [^.]+\.|Also a nested dependency[^.]*\.|Manual:.*)/g) ?? []).join(" ");
  const { entry } = planEntry(cur.upstream, cur.sha, { label: cur.ref, paths, notes: manual });
  entry.name = name;
  entry.upstream = cur.upstream;
  entry.ref_type = cur.ref_type; entry.pin_nested = cur.pin_nested ?? {};
  // A "Manual:" note means a human tightened exclude/keep after reading the scripts; keep that
  // decision and only regenerate the analysis text around it.
  if (/Manual:/.test(cur.notes ?? "")) { entry.exclude = cur.exclude ?? []; entry.keep = cur.keep ?? []; entry.notes = cur.notes; }
  if (opts.dryRun) { console.log(JSON.stringify(entry, null, 2)); return entry; }
  sh("yq", ["-i", `del(.actions[] | select(.name == "${name}"))`, MANIFEST_PATH]);
  appendEntry(entry);
  const fresh = loadManifest();
  const full = fresh.actions.find((a) => a.name === name);
  const r = syncEntry(full, fresh, join(MANIFEST_PATH, ".."));
  refreshReadme(fresh);
  if (!opts.quiet) console.log(`refreshed ${name}@${full.ref} (${full.sha.slice(0, 12)}): ${r.kept} files kept, ${r.removed.length} removed${r.uses.changes.length ? `, ${r.uses.changes.length} nested uses rewritten` : ""}`);
  return full;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try { const o = parseArgs(process.argv.slice(2)); o.refresh ? refreshAction(o.spec, o) : addAction(o.spec, o); }
  catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
}
