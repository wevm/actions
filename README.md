# Wevm Actions

This repository contains GitHub Actions that are shared across repos in the `wevm` GitHub org.

> [!WARNING]  
> These actions are not designed for use _outside_ of the `wevm` GitHub org.

## `github-sts`

Exchanges the workflow's GitHub OIDC token for a short-lived GitHub App token, scoped by a trust policy at `.github/sts/<policy>.sts.yaml` in the `scope` repository. The token is revoked automatically when the job finishes.

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - id: sts
    uses: wevm/actions/.github/actions/github-sts@main
    with:
      policy: deploy
      ttl: 15m
      # scope: wevm/viem             # defaults to the current repository
      # host: staging.gh-sts.wevm.dev # defaults to gh-sts.wevm.dev
      # retry-timeout: 90

  - env:
      GH_TOKEN: ${{ steps.sts.outputs.token }}
    run: gh api "repos/${GITHUB_REPOSITORY}"
```

Outputs: `token`, `expires-at`.

## `autofix`

Reusable pnpm autofix workflow at `.github/workflows/autofix.yml`. The caller
provides its existing formatting/version-generation commands. A read-only job
checks out the PR head (not its merge commit), installs dependencies without a
shared cache, and uploads changes to tracked regular files. A separate job never
checks out or executes repository code: it validates the artifact and publishes
through GitHub's API with a five-minute STS token, automatically revoked afterward.

```yaml
name: Autofix
on:
  pull_request:
  push:
    branches: [main]
permissions: {}
jobs:
  autofix:
    uses: wevm/actions/.github/workflows/autofix.yml@<reviewed-sha>
    permissions:
      contents: read
      id-token: write
    with:
      command: |
        pnpm check
        pnpm version:update
```

The production STS App must be installed on the caller repository. Commit
`.github/sts/autofix.sts.yaml` to its default branch before enabling publication:

```yaml
subject: repo:wevm/example:pull_request
claim_pattern:
  repository_id: 'REPOSITORY_ID'
  repository_owner_id: '109633172'
  event_name: pull_request
  workflow_ref: 'wevm/example/\.github/workflows/autofix\.yml@refs/pull/[1-9][0-9]*/merge'
  job_workflow_ref: 'wevm/actions/\.github/workflows/autofix\.yml@REVIEWED_SHA'
permissions:
  contents: write
  pull_requests: read
max_ttl: 5m
```

Replace the repository name/ID and `REVIEWED_SHA` with the exact reusable-workflow
pin. Repositories using immutable OIDC subjects must also include their owner and
repository IDs in `subject`. Do not replace the workflow pin with a wildcard.

Only same-repository, non-Dependabot PR branches receive automatic commits. Forks,
Dependabot, and pushes to `main` are check-only: if fixes are needed, the job fails
with a downloadable `fixes.patch` (retained for one day). Apply it to the revision
that was checked, after reviewing it. Nothing pushes directly to the default
branch. `.github` changes, symlinks, and executable-file changes require manual
fixes; untracked files are not included. Changes are capped at 100 files / 5 MiB.

Moved or closed PRs are left untouched. GitHub's `expectedHeadOid` check also
rejects a push racing with publication; the workflow never force-pushes. A second
fix on an autofix commit fails rather than creating a commit loop. Other workflows
are never cancelled by this workflow; the caller may cancel its own stale runs.
App-authored fix commits trigger normal PR CI. This replaces autofix.ci's
intentional failed check and default cancellation of other checks.

For migration, update any required-check names to the new nested job names.
Keep the old App installed until the new workflow has been exercised. Test the
publisher locally with `node --test .github/actions/autofix/index.test.mjs`.
