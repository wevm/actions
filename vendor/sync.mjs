#!/usr/bin/env node
// Materialize vendor/<owner>/<repo>/ from vendor-manifest.yml.
//
//   node vendor/sync.mjs                 sync every entry, regenerate the README table
//   node vendor/sync.mjs --check         CI: rebuild into a temp dir and fail on any drift
//   node vendor/sync.mjs docker/login-action ...   only the named entries
//
// Vendored trees are never edited by hand: change the manifest and re-run.
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, MANIFEST_FILE, VendorError, loadManifest, fetchUpstream, applyExcludes, applyPackageTransforms, applySecurityPatches, rewriteUsesInTree, walk, readmeUrl, writeStamp, readStamps, renderReadmeTable, updateReadmeText, yqJson } from "./lib.mjs";

const args = process.argv.slice(2);
const check = args.includes("--check");
const quiet = args.includes("--quiet");
const only = args.filter((a) => !a.startsWith("--"));
const log = (...m) => { if (!quiet) console.log(...m); };

export function syncEntry(entry, manifest, base) {
  const dest = join(base, manifest.vendor_dir, entry.name);
  rmSync(dest, { recursive: true, force: true });
  const { url, date } = fetchUpstream(entry, dest);
  const before = walk(dest);
  const readme_url = readmeUrl(entry.upstream ?? entry.name, entry.sha, before);
  const actionFile = ["action.yml", "action.yaml"].map((f) => join(dest, f)).find(existsSync);
  const description = actionFile ? String(yqJson(actionFile, ".description // \"\"") ?? "") : "";
  const removed = applyExcludes(dest, entry, manifest);
  const transforms = [...applyPackageTransforms(dest, entry), ...applySecurityPatches(dest, entry)];
  const uses = rewriteUsesInTree(dest, entry, manifest);
  if (uses.missing.length) throw new VendorError(`${entry.name} references actions that are neither vendored nor allowed by policy:\n  ${uses.missing.join("\n  ")}\nAdd them with: node vendor/add.mjs <owner/repo>@<ref>  (or run add.mjs --with-deps)`);
  if (uses.unpinned.length) throw new VendorError(`${entry.name} has nested GitHub-authored references that are not pinned to a SHA (the org policy requires it):\n  ${uses.unpinned.join("\n  ")}\nRecord the resolved commit under pin_nested in ${MANIFEST_FILE} (add.mjs does this automatically).`);
  writeStamp(dest, {
    upstream: url, ref: entry.ref, ref_type: entry.ref_type ?? "tag", sha: entry.sha, upstream_commit_date: date,
    readme_url, description,
    consume_as: `${manifest.org}/${manifest.vendor_dir}/${entry.name}@<reviewed-sha>`,
    files_removed: removed.length, nested_rewrites: uses.changes,
    ...(transforms.length ? { transforms } : {}),
  });
  return { removed, transforms, uses, kept: walk(dest).length };
}

export function refreshReadme(manifest = loadManifest()) {
  const readmePath = join(ROOT, "README.md");
  const readme = readFileSync(readmePath, "utf8");
  const updated = updateReadmeText(readme, renderReadmeTable(manifest, readStamps(manifest)));
  if (updated !== readme) writeFileSync(readmePath, updated);
  return updated !== readme;
}

export function main() {
  const manifest = loadManifest();
  const entries = manifest.actions.filter((a) => only.length === 0 || only.includes(a.name));
  if (!entries.length) throw new VendorError(only.length ? `no manifest entry matches ${only.join(", ")}` : "manifest has no actions");
  const base = check ? mkdtempSync(join(tmpdir(), "vendor-check-")) : ROOT;
  const failures = [];
  for (const e of entries) {
    try {
      const r = syncEntry(e, manifest, base);
      log(`${check ? "checked" : "synced "} ${e.name}@${e.ref} (${e.sha.slice(0, 12)}): ${r.kept} files kept, ${r.removed.length} removed${r.transforms.length ? `, ${r.transforms.length} transformed` : ""}${r.uses.changes.length ? `, ${r.uses.changes.length} nested uses rewritten` : ""}`);
    } catch (err) { failures.push(`${e.name}: ${err.message}`); console.error(`error: ${e.name}: ${err.message}`); }
  }
  if (failures.length) throw new VendorError(`${failures.length} entr${failures.length === 1 ? "y" : "ies"} failed to sync`);

  // README table (always from the full manifest, using the stamps on disk or just written)
  const stamps = check
    ? manifest.actions.map((a) => { const p = join(entries.includes(a) ? base : ROOT, manifest.vendor_dir, a.name, ".vendored.json"); return { entry: a, stamp: existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null }; })
    : readStamps(manifest);
  const readmePath = join(ROOT, "README.md");
  const readme = readFileSync(readmePath, "utf8");
  const updated = updateReadmeText(readme, renderReadmeTable(manifest, stamps));

  if (!check) {
    if (updated !== readme) { writeFileSync(readmePath, updated); log("README.md: 3rd-party actions table updated"); }
    return;
  }
  let drift = false;
  for (const e of entries) {
    const a = join(base, manifest.vendor_dir, e.name), b = join(ROOT, manifest.vendor_dir, e.name);
    const r = spawnSync("diff", ["-r", "-q", a, b], { encoding: "utf8" });
    if (r.status !== 0) { drift = true; console.error(`DRIFT ${manifest.vendor_dir}/${e.name}:\n${(r.stdout || r.stderr).replace(new RegExp(base, "g"), "<expected>")}`); }
    for (const path of walk(a)) {
      if (!existsSync(join(b, path))) continue; // Reported by diff above.
      if ((lstatSync(join(a, path)).mode & 0o111) !== (lstatSync(join(b, path)).mode & 0o111)) {
        drift = true;
        console.error(`DRIFT ${manifest.vendor_dir}/${e.name}/${path}: executable mode differs`);
      }
    }
  }
  if (updated !== readme) { drift = true; console.error("DRIFT README.md: the 3rd-party actions table is out of date"); }
  rmSync(base, { recursive: true, force: true });
  if (drift) throw new VendorError("vendored tree does not match the manifest; run `node vendor/sync.mjs` and commit the result");
  log(`ok: ${entries.length} vendored action${entries.length === 1 ? "" : "s"} match ${MANIFEST_FILE}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try { main(); } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
}
