# Reviewed snapshot releases

This repository uses [Changesets beyond npm](https://changesets.dev/guide/beyond-npm)
to version **one private root package**, `@wevm/actions`. Its version identifies
the entire action snapshot, not individual upstream action versions. Vendored
packages are not workspaces. Existing vendor slots and major-version paths stay
independent.

The baseline is the existing immutable **v1.0.0** tag at
`8963daf30237417f873c8e2f17e3bf9415e3a7b9`. Setup adds no pending changeset and
does not publish, retag, or backfill a GitHub Release for that baseline.

## Proposing a release

Use Node 24 and install the pinned CLI (the scripts also use Git, Mike Farah's
`yq`, and `jq`, as provided on GitHub's Ubuntu runners):

```sh
npm ci --ignore-scripts
npm run changeset
```

Choose `@wevm/actions`, a bump type, and write the user-facing release note. Commit
the resulting `.changeset/*.md` with the change. Use patch for compatible vendor
updates and fixes; minor/major for corresponding repository-wide compatibility
changes. Weekly vendor proposals automatically include a patch changeset with
the slot, upstream ref, and SHA. Review upstream code and bundled diffs before
merging; reproducibility is not a security review.

After the merged `main` commit passes the **entire Vendor check workflow** (tooling,
reproducibility, lint and all smoke jobs), Release maintains the
`changeset-release/main` PR. It uses the existing vendored Changesets action
`abitype` slot (upstream v2.1.2, compatible with CLI v3.0.3), pinned to a reviewed
repository commit. No new action import or vendored runtime edits are needed.

The version PR consumes pending changesets, updates `package.json`, the root lock
version and `CHANGELOG.md`, and refreshes first-party `wevm/actions/...@SHA` uses
under `.github/actions` and `.github/workflows` to the already-merged, CI-checked
base commit. It never pins to its own future commit. It does not change vendor
paths, the manifest's `self_sha`, or generated vendor trees. Nested vendor
dependencies still follow the separate bootstrap process in `vendor/README.md`.

**Review and merge the version PR manually when ready to publish.** Review the
version, notes, and wrapper pins, and require PR CI. Changesets may regenerate this
PR as more changesets merge: put release-note edits in the original changesets on
`main`, rather than relying on edits to the generated branch being preserved.

## Publishing (GitHub only, never npm)

Merging the version PR is the publication approval. Only after **Vendor check on
that exact merge commit succeeds** does Release create a create-only `vX.Y.Z` tag
at that SHA and a GitHub Release whose body is that version's generated changelog
section. The publisher verifies the merged Changesets PR, version increase, no
pending changesets, and that the first-party pins resolve to the same action trees
included in the release. A stale pin fails closed; regenerate/review the version
PR on current `main` rather than releasing stale vendor code.
If an out-of-date version PR was already merged, add a corrective changeset and
review a new version PR; the failed snapshot stays unpublished.

There is no npm publish command, npm token, floating major tag, or auto-merge.
[`privatePackages`](https://changesets.dev/guide/config#privatepackages) is
`{ "version": true, "tag": false }`: Changesets versions the private package but
does not tag it. The custom publisher owns tags and releases, not Changesets'
npm-oriented publishing path. Ordinary pushes with an unchanged version cannot
publish. A direct version edit outside a merged version PR is rejected.

On a transient failure, rerun **Release for the original merge SHA**, or rerun its
Vendor check to emit another completion event. This also recovers a completion
superseded by GitHub's concurrency queue. A tag already pointing at that exact
commit is reused, including an annotated tag; a tag pointing elsewhere is an
error and is never moved. A tag created before a failed Release API request is
safe to retry. An existing release with matching notes is left untouched; changed
notes or draft/prerelease state require manual inspection, not overwriting.
Rerunning an unrelated later push does not backfill a missed release.

## Authentication and first-run prerequisites

Merge `.github/sts/release-pr.sts.yaml` on `main`. Confirm the existing production
STS App installation for `wevm/actions` grants **contents, pull requests, and
workflows write** (workflow permission is needed to refresh workflow pins). Any App
permission change requires separate human approval; this setup does not change
the installation, repository settings, branch protection, or tag rules.

The five-minute policy restricts issuance by repository/owner IDs, `main`,
`workflow_run`, and the exact Release workflow. The App token allows version PR
pushes to trigger CI, unlike `GITHUB_TOKEN`. It is used only after dependency
installation without lifecycle scripts and CI verification, by reviewed code;
the action pushes via GitHub's API without storing Git credentials. STS revokes
the token at job end. Its repository-scoped write permissions cannot be limited
to just the version branch: keep branch protection and human review enabled.

Tag/release creation uses a separate job's `GITHUB_TOKEN` with contents write.
It installs nothing and runs no vendored runtime. The publisher only uses the
checked-out, reviewed scripts from the successful `main` SHA, never PR artifacts
or unmerged proposed vendor code. Release events created by this token do not
trigger other workflows; consumers discover tags through their normal update
checks. This automation never mutates existing tags; enforcing immutability
against administrators or other tokens needs repository rules/release settings.

## Local checks

```sh
npm ci --ignore-scripts
node --test vendor/*.test.js .github/actions/*/*.test.mjs .github/workflows/*.test.mjs .github/scripts/*.test.mjs
actionlint .github/workflows/*.yml
node vendor/sync.mjs --check
```

Release tests use real temporary Git repositories and the real pinned CLI, with
GitHub API responses simulated. They do not write tags, releases, or PRs to GitHub.
They need full local Git history including v1.0.0 (CI checks out full history).
Live STS issuance, App permissions, branch rules and hosted CI must be confirmed
after this setup is reviewed and merged.
