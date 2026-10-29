import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest, applyExcludes, applyPackageTransforms, applySecurityPatches, globToRegExp, matchesAny, rewriteUsesText, compareVersions, normalizeCommitDate, updateReadmeText, README_BEGIN, README_END } from "./lib.mjs";

test("manifest keeps independent versions of one upstream in separate slots", () => {
  const dir = mkdtempSync(join(tmpdir(), "vendor-slots-"));
  try {
    const path = join(dir, "manifest.json");
    const manifest = {
      self_sha: "a".repeat(40), self_tag: "bootstrap",
      actions: [
        { name: "changesets/action/abitype", ref: "v2.1.2", sha: "b".repeat(40) },
        { name: "changesets/action/wagmi", ref: "v1.9.0", sha: "c".repeat(40) },
      ],
    };
    writeFileSync(path, JSON.stringify(manifest));
    const { actions } = loadManifest(path);
    assert.deepEqual(actions.map(({ name, upstream, sha }) => ({ name, upstream, sha })), [
      { name: "changesets/action/abitype", upstream: "changesets/action", sha: "b".repeat(40) },
      { name: "changesets/action/wagmi", upstream: "changesets/action", sha: "c".repeat(40) },
    ]);
    for (const name of ["changesets/action/abitype", "changesets/action", "changesets/action/..", "../action/other"]) {
      manifest.actions[1].name = name;
      writeFileSync(path, JSON.stringify(manifest));
      assert.throws(() => loadManifest(path), /duplicate|bad name/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("security patches apply deterministically and fail when upstream no longer matches", () => {
  const dir = mkdtempSync(join(tmpdir(), "vendor-security-patch-"));
  try {
    mkdirSync(join(dir, "vendor/patches"), { recursive: true });
    const dest = join(dir, "action");
    mkdirSync(dest);
    writeFileSync(join(dest, "index.js"), "vulnerable\n");
    writeFileSync(join(dir, "vendor/patches/fix.patch"), "--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-vulnerable\n+fixed\n");
    const entry = { security_patches: ["vendor/patches/fix.patch"] };
    assert.deepEqual(applySecurityPatches(dest, entry, dir), entry.security_patches);
    assert.equal(readFileSync(join(dest, "index.js"), "utf8"), "fixed\n");
    assert.throws(() => applySecurityPatches(dest, entry, dir), /failed/);
    assert.deepEqual(applySecurityPatches(dest, {}, dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commit timestamps are stable across Git UTC formats and preserve non-UTC offsets", () => {
  assert.equal(normalizeCommitDate("2024-02-15T00:16:04+00:00\n"), "2024-02-15T00:16:04Z");
  assert.equal(normalizeCommitDate("2024-02-15T00:16:04Z\n"), "2024-02-15T00:16:04Z");
  assert.equal(normalizeCommitDate("2024-02-15T05:46:04+05:30\n"), "2024-02-15T05:46:04+05:30");
  assert.equal(normalizeCommitDate("2024-02-14T16:16:04-08:00\n"), "2024-02-14T16:16:04-08:00");
});

test("glob patterns are anchored at the tree root and match whole directories", () => {
  assert.ok(globToRegExp("src/").test("src/index.ts"));
  assert.ok(globToRegExp("src/").test("src"));
  assert.ok(!globToRegExp("src/").test("dist/src/index.js"), "not anchored at depth");
  assert.ok(globToRegExp("**/*.map").test("dist/index.js.map"));
  assert.ok(globToRegExp("**/*.map").test("index.js.map"));
  assert.ok(globToRegExp("*.png").test("logo.png"));
  assert.ok(!globToRegExp("*.png").test("dist/logo.png"), "root-only image pattern");
  assert.ok(globToRegExp("tsconfig*.json").test("tsconfig.build.json"));
  assert.ok(globToRegExp("**").test("anything/at/all"));
  assert.ok(globToRegExp(".github/").test(".github/workflows/ci.yml"));
  assert.equal(matchesAny("LICENSE.md", ["LICENSE*"]), "LICENSE*");
  assert.equal(matchesAny("dist/index.js", ["src/", "**/*.map"]), null);
});

test("nested uses: third-party refs get repository pins, GitHub-authored refs stay or get pinned", () => {
  const text = [
    "description: |",
    "  Example:",
    "    - uses: actions/cache@v4",
    "    - uses: example/not-an-action@main",
    "runs:",
    "  using: composite",
    "  steps:",
    "    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
    "    - uses: actions/cache@v4",
    "    - uses: peter-evans/create-pull-request@5f6978faf089d4d20b00c7766989d076bb2fc7f1 # v8.1.1",
    "    - uses: 'docker/login-action@v3'",
    "    - uses: ./local",
    "    - uses: docker://alpine:3",
    "    - uses: tempoxyz/gh-actions/actions/github-sts@abc",
    "    - run: |",
    "        cat <<'YAML'",
    "        - uses: actions/cache@v4",
    "        YAML",
  ].join("\n");
  const ctx = { org: "tempoxyz/gh-actions", allowedUpstreams: ["actions/", "github/"], vendored: new Set(["peter-evans/create-pull-request"]), pinNested: { "actions/cache@v4": "0123456789012345678901234567890123456789" }, selfSha: "7e2ea6e1a8f5a22f16c2d4b389ffde25da93fa1b", selfTag: "2026-09-22T22-21-59Z-7e2ea6e1" };
  const r = rewriteUsesText(text, ctx);
  assert.deepEqual(r.missing, ["docker/login-action@v3"]);
  assert.deepEqual(r.unpinned, []);
  assert.match(r.text, /uses: tempoxyz\/gh-actions\/vendor\/peter-evans\/create-pull-request@7e2ea6e1a8f5a22f16c2d4b389ffde25da93fa1b # 2026-09-22T22-21-59Z-7e2ea6e1/);
  assert.match(r.text, /uses: actions\/cache@0123456789012345678901234567890123456789 # actions\/cache@v4/);
  assert.match(r.text, /uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1/);
  assert.match(r.text, /uses: \.\/local/);
  assert.match(r.text, /uses: docker:\/\/alpine:3/);
  assert.ok(r.text.startsWith("description: |\n  Example:\n    - uses: actions/cache@v4\n    - uses: example/not-an-action@main\n"));
  assert.ok(r.text.endsWith("    - run: |\n        cat <<'YAML'\n        - uses: actions/cache@v4\n        YAML"));
  const r2 = rewriteUsesText("    - uses: github/codeql-action/upload-sarif@v3\n", { ...ctx, pinNested: {} });
  assert.deepEqual(r2.unpinned, ["github/codeql-action/upload-sarif@v3"]);
});

test("nested explicit pins can be refreshed through manifest overrides", () => {
  const original = "1".repeat(40), updated = "2".repeat(40);
  const target = `actions/cache@${original}`;
  const ctx = { org: "tempoxyz/gh-actions", allowedUpstreams: ["actions/"], vendored: new Set(), pinNested: { [target]: updated } };
  const r = rewriteUsesText(`    - uses: ${target} # old release\n`, ctx);
  assert.equal(r.text, `    - uses: actions/cache@${updated} # ${target}\n`);
  assert.deepEqual(r.unpinned, []);
  assert.deepEqual(r.changes, [`${target} -> actions/cache@${updated}`]);
  assert.equal(rewriteUsesText(`    - uses: ${target}\n`, { ...ctx, pinNested: {} }).text, `    - uses: ${target}\n`);
});

test("version comparison prefers numeric order and handles v prefixes", () => {
  assert.deepEqual(["v1.10.0", "v1.9.2", "v2", "1.9.10"].sort(compareVersions), ["v1.9.2", "1.9.10", "v1.10.0", "v2"]);
});

test("README table replaces only the marked block", () => {
  const readme = `# x\n\n${README_BEGIN}\nold\n${README_END}\n\nrest\n`;
  const out = updateReadmeText(readme, "| a |\n|---|");
  assert.equal(out, `# x\n\n${README_BEGIN}\n| a |\n|---|\n${README_END}\n\nrest\n`);
  assert.throws(() => updateReadmeText("no markers", "x"), /markers/);
});

test("package transform removes development-only dependencies", () => {
  const dir = mkdtempSync(join(tmpdir(), "vendor-package-transform-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "prebuilt-action",
        dependencies: { runtime: "1.0.0" },
        devDependencies: { eslint: "7.32.0" },
      }),
    );
    assert.deepEqual(
      applyPackageTransforms(dir, {
        name: "owner/action",
        strip_dev_dependencies: true,
      }),
      ["package.json:devDependencies"],
    );
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "package.json"))), {
      name: "prebuilt-action",
      dependencies: { runtime: "1.0.0" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime imports retain nested dependency licenses while excluding documentation", () => {
  const dir = mkdtempSync(join(tmpdir(), "vendor-license-"));
  try {
    const dependency = join(dir, "node_modules/dependency");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, "LICENSE.md"), "Upstream license\n");
    writeFileSync(join(dependency, "README.md"), "Usage docs\n");
    const removed = applyExcludes(dir, { keep: [], exclude: [] }, { default_exclude: ["**/*.md"] });
    assert.deepEqual(removed, ["node_modules/dependency/README.md"]);
    assert.equal(readFileSync(join(dependency, "LICENSE.md"), "utf8"), "Upstream license\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exclusions remove documentation symlinks after removing their targets", () => {
  const dir = mkdtempSync(join(tmpdir(), "vendor-symlink-"));
  try {
    writeFileSync(join(dir, "AGENTS.md"), "Upstream guidance\n");
    symlinkSync("AGENTS.md", join(dir, "CLAUDE.md"));
    applyExcludes(dir, { keep: [], exclude: [] }, { default_exclude: ["**/*.md"] });
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
