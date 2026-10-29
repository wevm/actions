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

## Vendored actions

Third-party action runtime files are copied at exact upstream commits; GitHub-owned
actions remain upstream and SHA-pinned. Consumers use
`wevm/actions/vendor/<owner>/<repo>/<slot>@<reviewed-sha>` with the same inputs as
upstream. Older slots preserve compatibility while consumers migrate; the pnpm v6
slot includes the patched bootstrap update. Pin the **wevm/actions commit**, not the
upstream commit listed below.

For consumer upgrades, use these shared entrypoints:

- `.github/actions/pnpm`: pnpm setup v6.1.0 and Node setup v6.4.0. Each repository's
  `packageManager` still selects its pnpm version; `skip-cache` remains supported.
- `vendor/pnpm/action-setup/v6`: the same pnpm setup without dependency installation,
  for callers that need a custom destination or `package_json_file`.
- `.github/workflows/lock-issue.yml`: lock-threads v6.0.2 with the existing 14-day policy.

The `pnpm-v4`, `lock-issue-v5.yml`, and older vendor paths remain available while
consumers migrate. Changesets requires a separate CLI migration: action v2 targets
Changesets CLI v3, while action v1 targets CLI v2. Do not unify those slots by
changing only the action path or its input names.

<!-- vendored-actions:begin -->
| Action | Version | Description |
|--------|---------|-------------|
| [`changesets/action/abitype`](https://github.com/changesets/action/blob/ae32849d5ba541f9ae29e40e22a623bc13562f51/README.md) | v2.1.2 (`ae32849`) | A GitHub action to automate releases with Changesets |
| [`changesets/action/ox`](https://github.com/changesets/action/blob/e0145edc7d9d8679003495b11f87bd8ef63c0cba/README.md) | v1.5.3 (`e0145ed`) | A GitHub action to automate releases with Changesets |
| [`changesets/action/viem`](https://github.com/changesets/action/blob/06245a4e0a36c064a573d4150030f5ec548e4fcc/README.md) | v1.4.10 (`06245a4`) | A GitHub action to automate releases with Changesets |
| [`changesets/action/wagmi`](https://github.com/changesets/action/blob/a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d/README.md) | v1.9.0 (`a45c4d5`) | A GitHub action to automate releases with Changesets |
| [`dessant/lock-threads/v5`](https://github.com/dessant/lock-threads/blob/1bf7ec25051fe7c00bdd17e6a7cf3d7bfb7dc771/README.md) | v5.0.1 (`1bf7ec2`) | Lock closed issues, pull requests and discussions after a period of inactivity |
| [`dessant/lock-threads/v6`](https://github.com/dessant/lock-threads/blob/89ae32b08ed1a541efecbab17912962a5e38981c/README.md) | v6.0.2 (`89ae32b`) | Lock closed issues, pull requests and discussions after a period of inactivity |
| [`pnpm/action-setup/v4`](https://github.com/pnpm/action-setup/blob/a7487c7e89a18df4991f7f222e4898a00d66ddda/README.md) | v4.1.0 (`a7487c7`) | Install pnpm package manager |
| [`pnpm/action-setup/v6`](https://github.com/pnpm/action-setup/blob/ea17c68df8912ef543352723c149a84f56e3d413/README.md) | v6.1.0 (`ea17c68`) | Install pnpm package manager |
| [`pnpm/action-setup/viem-wagmi`](https://github.com/pnpm/action-setup/blob/b906affcce14559ad1aafd4ab0e942779e9f58b1/README.md) | v4.3.0 (`b906aff`) | Install pnpm package manager |
<!-- vendored-actions:end -->

See [vendor/README.md](vendor/README.md) for imports, verification, updates, and
the STS rollout prerequisites. Vendoring controls when upstream code changes enter
our workflows; it does not sandbox actions or eliminate vulnerabilities in a pinned
version. Other third-party actions are not yet migrated, so org-wide enforcement
must wait. The issue-labeled workflow uses the runner's GitHub CLI to post the
reproduction request and close the issue as `not_planned`, with `issues: write`
permission.
