# Vendoring

`add.mjs`, `sync.mjs`, `update.mjs`, `lib.mjs`, and the general tooling tests are
adapted from [tempoxyz/gh-actions at 3535ae62c56955bba10cd5ee1577075582b08ed5](https://github.com/tempoxyz/gh-actions/tree/3535ae62c56955bba10cd5ee1577075582b08ed5/vendor).
Local adaptations add independent version slots, executable-mode verification,
and wevm defaults. Dependency discovery parses YAML nodes so description examples
and shell heredocs are not treated as nested actions.
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
`self_sha` containing that dependency. Existing version slots need explicit
dependency resolution before importing such wrappers. Do not introduce a floating self-reference to avoid a bootstrap
commit: publish the dependency snapshot first, then pin wrappers to it.

## Updates and STS

**Vendor Update** runs weekly on Mondays at 09:17 UTC. It can also be run manually
on `main`, optionally selecting one manifest name.
It selects the newest same-major release whose upstream commit is at least seven
days old, falling back to an eligible older release while the latest cools down.
The cooldown measures commit age, not release publication age. Failed upstream
lookups fail the run rather than being reported as no updates.

It keeps at most one open proposal per slot, without auto-merging or changing
consumer pins. Existing PRs and reviewer edits are left alone; a closed proposal
is not reopened. If a push succeeds but PR creation fails, a rerun creates the
missing PR without rewriting the branch. Review the upstream source compare and bundled diff;
passing regeneration only proves the copy matches its recorded source.
After merging an update, separately update the SHA in wrappers and consumers.

### Delivering updates to consumers

Maintainers publish immutable version tags such as `v1.0.0` on reviewed `main`
commits after CI passes. Never move an existing tag. These versions identify the
whole WEVM snapshot, not the upstream versions in the vendor paths. Consumers
continue to pin full commit SHAs; Dependabot uses version tags to discover updates.
Pin the initial snapshot explicitly so later updates follow tagged releases rather
than relying on Dependabot's branch lookup for untagged commits.

Dependabot checks workflows and first-party composites under `.github/actions/*`
weekly on Mondays, with a seven-day cooldown and one grouped version-update PR.
It does not scan generated `vendor/` trees. Consumers need the same directory
coverage in their own configuration; a root-only entry misses nested composites.
Review and merge proposals manually. GitHub-owned action upgrades can appear in
the same group and require their own compatibility review.

The delivery order is:

1. Review and merge a vendor update, verify CI, then publish a new snapshot tag.
2. Review and merge the wrapper-pin update, verify CI, then tag that snapshot too.
3. Review consumer proposals pointing at the tagged wrapper snapshot. Direct
   vendor consumers can use the first snapshot without waiting for wrapper changes.

Keep existing vendor paths when updating SHAs. Moving to another major-version
slot is a separate compatibility change. Tag publication is manual; merging a
vendor PR alone does not publish a release or update downstream pins.

### Updater authentication

The workflow uses a five-minute STS token only to push its proposal and open a PR.
Before the first run, merge `.github/sts/vendor-update.sts.yaml` to `main` and
confirm the production STS App installation includes `wevm/actions` with contents
and pull-request write permissions. Do not expand App access automatically.
The policy restricts issuance to this repository ID, owner ID, workflow, and a
scheduled or manual run on `main`; it does **not** restrict the token to a branch, so branch
protection and human review remain necessary. STS replaces a long-lived PAT,
not the review gate.

No deployment, release, org-wide policy change, or privileged update run is part
of the migration. The issue-label workflow uses the runner's GitHub CLI instead
of the inaccessible upstream issue helper.

## CI coverage

PRs and pushes to `main` run vendor reproducibility checks, automatically discover
tooling and first-party tests, and lint first-party workflows/actions with
actionlint and offline zizmor. Vendored source is not linted to our conventions.
GitHub-hosted smoke jobs exercise both pnpm wrappers with caching enabled and
disabled, default and custom Node versions, and a local dependency fixture.
STS forwarding and issue automation have local contract tests; live STS exchange
tests remain in the separate STS fixture repositories.

Run the local tests with:

```sh
node --test vendor/*.test.js .github/actions/*/*.test.mjs .github/workflows/*.test.mjs
actionlint .github/workflows/*.yml
```

## Active-repository rollout

The 2026-10-29 inventory listed 106 repositories and scanned workflow files and
action manifests in the 40 nonempty, unarchived repositories pushed since
2026-07-31. Recent pushes are a scope heuristic, not proof of ongoing maintenance.
The `revm`, `alloy`, and `evm` upstream mirrors have no Actions runs and are excluded,
as is the `viem-ghsa-f38w-vmh3-v6mc` advisory snapshot. `saltgen.sh` and `zero-swift`
have no workflow or action files. Archived and older repositories remain unchanged.

The remaining scope is `abitype`, `actions`, `chaindex`, `cove`, `cuer`, `curl.md`,
`frog`, `github-sts`, `github-sts-test-production`, `github-sts-test-staging`,
`handshakes`, `incur`, `monoshot`, `mppx`, `nanoswift`, `ondine`, `openstats`, `ox`,
`prool`, `shiki2`, `solilo`, `tips.sh`, `twoslash2`, `viem`, `viem-v3`, `vocs`,
`wagmi`, `wata`, `worksteps`, `xframe-tools`, and `zyzz`.

The `reth`, `nethermind`, and `zero` forks are excluded even though they have recent
CI activity. They keep their upstream action setup. Snapshots used only by these
forks are omitted; shared snapshots remain for first-party consumers. Manifest
consumer notes record the original inventory, including forks sharing those pins.

The additional standalone snapshots preserve existing upstream commits. Floating
consumer tags were resolved once; this does not upgrade pinned consumers. Copies
in this repository are not a completed consumer rollout: publish and review the
snapshot before replacing consumer references with its full commit SHA.

Repository-level enforcement for first-party repos still needs these migrations:

- Composite third-party actions need their nested dependencies published before
  their wrappers can pin them. Version-specific slots must not be silently collapsed.
- Tempo reusable security workflows and actions in `mppx` and our STS
  wrapper need a separate migration. Their relative script dependencies, scanner
  identities, service authorization, and source redistribution permission must be
  checked. Moving a reusable workflow changes its OIDC `job_workflow_ref`.
- MPP conformance workflows check out a selected upstream suite and execute its
  local setup action. Freezing that setup while leaving the suite dynamic changes
  how future suite revisions work; it is not a transparent reference replacement.
- pnpm consumers on older bootstrap releases need compatibility review against
  the existing patched v6 slot rather than copying known-vulnerable versions.

GitHub-owned actions remain upstream and must be SHA-pinned before enforcement.
Apply the restrictive policy per first-party repository, not organization-wide:
repositories cannot loosen an overriding org policy. Keep the org policy permissive
enough for the excluded forks, and explicitly configure new first-party repos.
No repository or organization settings have been changed by this import.

Vendoring is not network isolation. Installer actions still download tools and
deployment actions still contact their providers. For example, Codecov verifies
downloaded CLI checksums/signatures, Foundry and Bun install selected tool releases,
and Scorecard's manifests launch upstream container images. Those runtime
dependencies and service credentials remain separate from the action source pin.
