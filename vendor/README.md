# Vendoring

`add.mjs`, `sync.mjs`, `update.mjs`, `lib.mjs`, and the general tooling tests are
adapted from [tempoxyz/gh-actions at 3535ae62c56955bba10cd5ee1577075582b08ed5](https://github.com/tempoxyz/gh-actions/tree/3535ae62c56955bba10cd5ee1577075582b08ed5/vendor).
Local adaptations add independent version slots, executable-mode verification,
and wevm defaults. The setup-uv-specific test is omitted because we do not vendor it.
Imported action licenses are retained alongside their runtime files.

Requires Node 20+, Git, tar, patch, and Mike Farah's `yq` (available on GitHub's
Ubuntu runners; `brew install yq` locally). No package installation or upstream
action code execution is needed to import or check a tree.

```sh
node vendor/add.mjs changesets/action@<upstream-sha> --slot abitype
node vendor/sync.mjs
node vendor/sync.mjs --check
node --test vendor/lib.test.js
node vendor/update.mjs
node vendor/update.mjs --apply changesets/action/abitype
```

`name` is the destination under `vendor/` and the update selector; `upstream` is
the source repository. Separate slots retain each consumer's existing version.
The updater tracks same-major releases for version tags and does not track bare
commits. Review the generated manifest's exclusions before committing. Keep all
runtime entrypoints, supporting files, and licenses. Do not hand-edit generated
trees: change the manifest and regenerate. `.vendored.json` records provenance.
`--check` compares a fresh import with the checked-in bytes and executable modes.

Nested third-party actions require an unslotted manifest entry and a published
`self_sha` containing that dependency. The initial imports are Node actions with
no nested `uses`. Do not introduce a floating self-reference to avoid a bootstrap
commit: publish the dependency snapshot first, then pin wrappers to it.

## Updates and STS

Run **Vendor Update** manually on `main`, optionally selecting one manifest name.
It proposes updates at least seven days old, one PR per slot, without auto-merging
or changing consumer pins. Review the upstream source compare and bundled diff;
passing regeneration only proves the copy matches its recorded source.
After merging an update, separately update the SHA in wrappers and consumers.

The workflow uses a five-minute STS token only to push its proposal and open a PR.
Before the first run, merge `.github/sts/vendor-update.sts.yaml` to `main` and
confirm the production STS App installation includes `wevm/actions` with contents
and pull-request write permissions. Do not expand App access automatically.
The policy restricts issuance to this repository ID, owner ID, workflow, and a
manual run on `main`; it does **not** restrict the token to a branch, so branch
protection and human review remain necessary. STS replaces a long-lived PAT,
not the review gate.

No deployment, release, org-wide policy change, or privileged update run is part
of the initial migration. The existing issue helper is deferred while its
upstream repository is inaccessible.
