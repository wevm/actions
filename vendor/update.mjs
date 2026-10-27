#!/usr/bin/env node
// Find newer upstream versions of vendored actions, optionally apply them.
//
//   node vendor/update.mjs                       table of available updates (respects the cooldown)
//   node vendor/update.mjs --json                machine-readable list, used by .github/workflows/vendor-update.yml
//   node vendor/update.mjs --apply <name>...     bump ref/sha in vendor-manifest.yml and re-sync those entries
//   flags: --min-age-days N   ignore upstream commits younger than N days (default 7, matches .pinact.yaml)
//          --all              include entries whose upstream commit is still inside the cooldown
//
// Tracking rules: a semver tag tracks the highest tag in the same major (v3.6.0 -> v3.x.y); a major-only
// or other moving tag (v1, cargo-udeps) tracks that same tag name; a branch tracks its tip; a bare commit
// is never updated automatically.
import { MANIFEST_PATH, VendorError, formatManifest, loadManifest, lsRemoteAll, resolveRef, compareVersions, upstreamUrl, sh, collectNestedUses, fetchUpstream } from "./lib.mjs";
import { syncEntry, refreshReadme } from "./sync.mjs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const minAgeDays = Number(opt("--min-age-days", "7"));
const applyNames = (() => { const i = argv.indexOf("--apply"); return i === -1 ? [] : argv.slice(i + 1).filter((a) => !a.startsWith("--")); })();

const SEMVER = /^v?(\d+)(\.\d+){1,3}([-+][0-9A-Za-z.]+)?$/;

function commitDate(name, sha) {
  const r = spawnSync("gh", ["api", `repos/${name}/commits/${sha}`, "--jq", ".commit.committer.date"], { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) return new Date(r.stdout.trim());
  // fallback without gh: shallow fetch and read the committer date
  const tmp = sh("mktemp", ["-d"]).trim();
  try { sh("git", ["init", "-q", tmp]); sh("git", ["-C", tmp, "fetch", "-q", "--depth", "1", upstreamUrl(name), sha]); return new Date(sh("git", ["-C", tmp, "log", "-1", "--format=%cI", "FETCH_HEAD"]).trim()); }
  finally { spawnSync("rm", ["-rf", tmp]); }
}

export function findUpdate(entry) {
  if (entry.ref_type === "commit") return { entry, status: "pinned commit; not tracked" };
  const upstream = entry.upstream ?? entry.name;
  const remote = lsRemoteAll(upstream);
  let candidate;
  if (entry.ref_type === "branch") {
    const tip = remote.find((r) => r.ref === `refs/heads/${entry.ref}`);
    if (!tip) return { entry, status: `branch ${entry.ref} no longer exists upstream` };
    candidate = { ref: entry.ref, sha: tip.sha };
  } else if (SEMVER.test(entry.ref)) {
    const major = entry.ref.match(SEMVER)[1], vPrefix = entry.ref.startsWith("v");
    const tags = remote.filter((r) => r.ref.startsWith("refs/tags/")).map((r) => ({ name: r.ref.slice(10).replace(/\^\{\}$/, ""), sha: r.sha, peeled: r.ref.endsWith("^{}") }));
    const names = [...new Set(tags.map((t) => t.name))].filter((n) => SEMVER.test(n) && n.match(SEMVER)[1] === major && n.startsWith("v") === vPrefix && !/[-+]/.test(n)).sort(compareVersions);
    const best = names[names.length - 1];
    if (!best) return { entry, status: `no ${vPrefix ? "v" : ""}${major}.x tags upstream` };
    const sha = (tags.find((t) => t.name === best && t.peeled) ?? tags.find((t) => t.name === best)).sha;
    candidate = { ref: best, sha };
  } else {
    // moving tag such as v1 or a tool name: follow the same tag
    try { const r = resolveRef(upstream, entry.ref, remote); candidate = { ref: entry.ref, sha: r.sha }; }
    catch (e) { return { entry, status: e.message }; }
  }
  if (candidate.sha === entry.sha) return { entry, status: "up to date" };
  const date = commitDate(upstream, candidate.sha);
  const ageDays = (Date.now() - date.getTime()) / 86400000;
  return { entry, update: { ...candidate, commit_date: date.toISOString(), age_days: Math.floor(ageDays), compare_url: `https://github.com/${upstream}/compare/${entry.sha}...${candidate.sha}` }, status: ageDays < minAgeDays ? `too new (${Math.floor(ageDays)}d < ${minAgeDays}d cooldown)` : "update available" };
}

export function applyUpdate(entry, update, manifest) {
  sh("yq", ["-i", `(.actions[] | select(.name == "${entry.name}") | .ref) = "${update.ref}" | (.actions[] | select(.name == "${entry.name}") | .sha) = "${update.sha}"`, MANIFEST_PATH]);
  const fresh = loadManifest();
  const e = fresh.actions.find((a) => a.name === entry.name);
  // nested GitHub-authored refs pinned by tag need a recorded commit; resolve any new ones
  const tmp = sh("mktemp", ["-d"]).trim();
  try {
    fetchUpstream({ ...e, ref_type: "commit" }, tmp, { verify: false });
    for (const { target } of collectNestedUses(tmp)) {
      const at = target.indexOf("@"); if (at === -1) continue;
      const path = target.slice(0, at), ref = target.slice(at + 1);
      if (!fresh.allowed_upstreams.some((p) => path.startsWith(p)) || /^[0-9a-f]{40}$/.test(ref) || e.pin_nested[target]) continue;
      const repo = path.split("/").slice(0, 2).join("/");
      const r = resolveRef(repo, ref);
      sh("yq", ["-i", `(.actions[] | select(.name == "${entry.name}") | .pin_nested["${target}"]) = "${r.sha}"`, MANIFEST_PATH]);
    }
  } finally { spawnSync("rm", ["-rf", tmp]); }
  const final = loadManifest();
  formatManifest(MANIFEST_PATH);
  return syncEntry(final.actions.find((a) => a.name === entry.name), final, dirname(MANIFEST_PATH));
}
function main() {
  const manifest = loadManifest();
  if (applyNames.length) {
    for (const name of applyNames) {
      const entry = manifest.actions.find((a) => a.name === name);
      if (!entry) throw new VendorError(`${name} is not in the manifest`);
      const r = findUpdate(entry);
      if (!r.update) { console.log(`${name}: ${r.status}`); continue; }
      if (r.status.startsWith("too new") && !flag("--all")) { console.log(`${name}: ${r.status}`); continue; }
      const res = applyUpdate(entry, r.update, manifest);
      console.log(`${name}: ${entry.ref} (${entry.sha.slice(0, 7)}) -> ${r.update.ref} (${r.update.sha.slice(0, 7)}); ${res.kept} files kept, ${res.removed.length} removed`);
    }
    refreshReadme();
    return;
  }
  const results = manifest.actions.map((a) => { try { return findUpdate(a); } catch (e) { return { entry: a, status: `error: ${e.message}` }; } });
  const updates = results.filter((r) => r.update && (flag("--all") || r.status === "update available"));
  if (flag("--json")) { console.log(JSON.stringify(updates.map((r) => ({ name: r.entry.name, current_ref: r.entry.ref, current_sha: r.entry.sha, new_ref: r.update.ref, new_sha: r.update.sha, commit_date: r.update.commit_date, age_days: r.update.age_days, compare_url: r.update.compare_url, status: r.status })), null, 2)); return; }
  for (const r of results) {
    const u = r.update ? ` -> ${r.update.ref} (${r.update.sha.slice(0, 7)}, ${r.update.age_days}d old)` : "";
    console.log(`${r.entry.name.padEnd(46)} ${r.entry.ref.padEnd(16)} ${r.status}${u}`);
  }
  console.log(`\n${updates.length} update${updates.length === 1 ? "" : "s"} available (cooldown ${minAgeDays}d)`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try { main(); } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
}
