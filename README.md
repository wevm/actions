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
| [`Swatinem/rust-cache/v2.8.2`](https://github.com/Swatinem/rust-cache/blob/779680da715d629ac1d338a641029a2f4372abb5/README.md) | v2.8.2 (`779680d`) | A GitHub Action that implements smart caching for rust/cargo projects with sensible defaults. |
| [`Swatinem/rust-cache/v2.9.2`](https://github.com/Swatinem/rust-cache/blob/6323deb102c322ba6fcbdcafc7e3dddab59af2b6/README.md) | v2.9.2 (`6323deb`) | A GitHub Action that implements smart caching for rust/cargo projects with sensible defaults. |
| [`Swatinem/rust-cache/v2.9.3`](https://github.com/Swatinem/rust-cache/blob/d1527c8f67ef9af357290475d4af4b0fab8f12e0/README.md) | v2.9.3 (`d1527c8`) | A GitHub Action that implements smart caching for rust/cargo projects with sensible defaults. |
| [`andresz1/size-limit-action/v1.8.0`](https://github.com/andresz1/size-limit-action/blob/94bc357df29c36c8f8d50ea497c3e225c3c95d1d/README.md) | v1.8.0 (`94bc357`) | size-limit action |
| [`astral-sh/setup-uv/rev-d0cc045d04cc`](https://github.com/astral-sh/setup-uv/blob/d0cc045d04ccac9d8b7881df0226f9e82c39688e/README.md) | v6.8.0 (`d0cc045`) | Set up your GitHub Actions workflow with a specific version of uv. |
| [`autofix-ci/action/v1.3.2`](https://github.com/autofix-ci/action/blob/635ffb0c9798bd160680f18fd73371e355b85f27/README.md) | v1.3.2 (`635ffb0`) | Automatically fix formatting/lint issues in pull requests |
| [`awalsh128/cache-apt-pkgs-action/rev-553a35bb8ebd`](https://github.com/awalsh128/cache-apt-pkgs-action/blob/553a35bb8ebd9fcabcb1c9451aa4c98e1b4ca8a9/README.md) | latest (`553a35b`) | Install APT based packages and cache them for future runs. |
| [`benchmark-action/github-action-benchmark/v1.22.2`](https://github.com/benchmark-action/github-action-benchmark) | v1.22.2 (`4322e57`) | Continuous Benchmark using GitHub pages as dash board for keeping performance |
| [`changesets/action/abitype`](https://github.com/changesets/action/blob/ae32849d5ba541f9ae29e40e22a623bc13562f51/README.md) | v2.1.2 (`ae32849`) | A GitHub action to automate releases with Changesets |
| [`changesets/action/ox`](https://github.com/changesets/action/blob/e0145edc7d9d8679003495b11f87bd8ef63c0cba/README.md) | v1.5.3 (`e0145ed`) | A GitHub action to automate releases with Changesets |
| [`changesets/action/v1.7.0`](https://github.com/changesets/action/blob/6a0a831ff30acef54f2c6aa1cbbc1096b066edaf/README.md) | v1.7.0 (`6a0a831`) | A GitHub action to automate releases with Changesets |
| [`changesets/action/viem`](https://github.com/changesets/action/blob/06245a4e0a36c064a573d4150030f5ec548e4fcc/README.md) | v1.4.10 (`06245a4`) | A GitHub action to automate releases with Changesets |
| [`changesets/action/wagmi`](https://github.com/changesets/action/blob/a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d/README.md) | v1.9.0 (`a45c4d5`) | A GitHub action to automate releases with Changesets |
| [`cloudflare/wrangler-action/rev-9acf94ace14e`](https://github.com/cloudflare/wrangler-action) | v3.15.0 (`9acf94a`) | Deploy your Cloudflare projects from GitHub using Wrangler |
| [`cloudflare/wrangler-action/v3.14.1`](https://github.com/cloudflare/wrangler-action) | v3.14.1 (`da0e0df`) | Deploy your Cloudflare projects from GitHub using Wrangler |
| [`cloudflare/wrangler-action/v4.0.0`](https://github.com/cloudflare/wrangler-action) | v4.0.0 (`ebbaa15`) | Deploy your Cloudflare projects from GitHub using Wrangler |
| [`cloudflare/wrangler-action/v4.1.3`](https://github.com/cloudflare/wrangler-action/blob/953926a2e2182532811c01a25e53647d93bf07c0/README.md) | v4.1.3 (`953926a`) | Deploy your Cloudflare projects from GitHub using Wrangler |
| [`codecov/codecov-action/rev-fb8b3582c8e4`](https://github.com/codecov/codecov-action/blob/fb8b3582c8e4def4969c97caa2f19720cb33a72f/README.md) | v7.0.0 (`fb8b358`) | GitHub Action that uploads coverage reports for your repository to codecov.io |
| [`codecov/codecov-action/v4.6.0`](https://github.com/codecov/codecov-action/blob/b9fd7d16f6d7d1b5d2bec1a2887e65ceed900238/README.md) | v4.6.0 (`b9fd7d1`) | GitHub Action that uploads coverage reports for your repository to codecov.io |
| [`codecov/codecov-action/v5.5.1`](https://github.com/codecov/codecov-action/blob/5a1091511ad55cbe89839c7260b706298ca349f7/README.md) | v5.5.1 (`5a10915`) | GitHub Action that uploads coverage reports for your repository to codecov.io |
| [`codecov/codecov-action/v7.1.1`](https://github.com/codecov/codecov-action/blob/303a32d7a59b442fa8d48b6a1cc6825c09c847a5/README.md) | v7.1.1 (`303a32d`) | GitHub Action that uploads coverage reports for your repository to codecov.io |
| [`davelosert/vitest-coverage-report-action/v2.13.1`](https://github.com/davelosert/vitest-coverage-report-action/blob/8f86cfb56ed6d5613ea8cdc5259f207fbfd51ece/README.md) | v2.13.1 (`8f86cfb`) | Provide a Vitest Test Coverage Report as Step-Summary and comment in Pull Requests |
| [`dessant/lock-threads/v5`](https://github.com/dessant/lock-threads/blob/1bf7ec25051fe7c00bdd17e6a7cf3d7bfb7dc771/README.md) | v5.0.1 (`1bf7ec2`) | Lock closed issues, pull requests and discussions after a period of inactivity |
| [`dessant/lock-threads/v6`](https://github.com/dessant/lock-threads/blob/89ae32b08ed1a541efecbab17912962a5e38981c/README.md) | v6.0.2 (`89ae32b`) | Lock closed issues, pull requests and discussions after a period of inactivity |
| [`docker/login-action/v4.6.0`](https://github.com/docker/login-action/blob/dbcb813823bdd20940b903addbd779551569679f/README.md) | v4.6.0 (`dbcb813`) | GitHub Action to login against a Docker registry |
| [`docker/setup-buildx-action/v4.2.0`](https://github.com/docker/setup-buildx-action/blob/bb05f3f5519dd87d3ba754cc423b652a5edd6d2c/README.md) | v4.2.0 (`bb05f3f`) | Set up Docker Buildx |
| [`dtolnay/rust-toolchain/rev-6c977a6ca407`](https://github.com/dtolnay/rust-toolchain/blob/6c977a6ca4077a0ceb28ffbe03f59d46e9ac8772/README.md) | `6c977a6` | Install the Rust toolchain |
| [`dtolnay/rust-toolchain/rev-b725eda52536`](https://github.com/dtolnay/rust-toolchain/blob/b725eda525362e7cf34af9a7243cac1e3f01a7ec/README.md) | stable (`b725eda`) | Install the Rust toolchain |
| [`foundry-rs/foundry-toolchain/v1.5.0`](https://github.com/foundry-rs/foundry-toolchain/blob/50d5a8956f2e319df19e6b57539d7e2acb9f8c1e/README.md) | v1.5.0 (`50d5a89`) | Install Foundry |
| [`foundry-rs/foundry-toolchain/v1.6.0`](https://github.com/foundry-rs/foundry-toolchain/blob/8b0419c685ef46cb79ec93fbdc131174afceb730/README.md) | v1.6.0 (`8b0419c`) | Install Foundry |
| [`foundry-rs/foundry-toolchain/v1.9.2`](https://github.com/foundry-rs/foundry-toolchain/blob/dba66c27052e63476d886f22216e119ba7e615bf/README.md) | v1.9.2 (`dba66c2`) | Install Foundry |
| [`jdx/mise-action/v4.2.5`](https://github.com/jdx/mise-action/blob/3c2e0cf82a5b2e5249f0d3635a4d83d0ae861518/README.md) | v4.2.5 (`3c2e0cf`) | Actions for working with mise runtime manager |
| [`marocchino/sticky-pull-request-comment/v2.9.4`](https://github.com/marocchino/sticky-pull-request-comment/blob/773744901bac0e8cbb5a0dc842800d45e9b2b405/README.md) | v2.9.4 (`7737449`) | Create comment on pull request, if exists update that comment. |
| [`nick-fields/retry/rev-ad984534de44`](https://github.com/nick-fields/retry/blob/ad984534de44a9489a53aefd81eb77f87c70dc60/README.md) | v4.0.0 (`ad98453`) | Retry a step on failure or timeout |
| [`nick-fields/retry/v3.0.2`](https://github.com/nick-fields/retry/blob/ce71cc2ab81d554ebbe88c79ab5975992d79ba08/README.md) | v3.0.2 (`ce71cc2`) | Retry a step on failure or timeout |
| [`ossf/scorecard-action/v2.4.1`](https://github.com/ossf/scorecard-action/blob/f49aabe0b5af0936a0987cfb85d86b75731b0186/README.md) | v2.4.1 (`f49aabe`) | Run OSSF Scorecard checks and output results in SARIF format |
| [`ossf/scorecard-action/v2.5.0`](https://github.com/ossf/scorecard-action/blob/fa7117db83c52d787ae5a89f350999701505d78e/README.md) | v2.5.0 (`fa7117d`) | Run OSSF Scorecard checks and output results in SARIF, JSON, or in-toto format |
| [`oven-sh/setup-bun/v2.2.0`](https://github.com/oven-sh/setup-bun/blob/0c5077e51419868618aeaa5fe8019c62421857d6/README.md) | v2.2.0 (`0c5077e`) | Download, install, and setup Bun to your path. |
| [`peter-evans/create-pull-request/v8.1.1`](https://github.com/peter-evans/create-pull-request/blob/5f6978faf089d4d20b00c7766989d076bb2fc7f1/README.md) | v8.1.1 (`5f6978f`) | Creates a pull request for changes to your repository in the actions workspace |
| [`planetscale/setup-pscale-action/rev-b6a50ee45b4b`](https://github.com/planetscale/setup-pscale-action/blob/b6a50ee45b4b24944e1d8de6e57b3a5f6476a1af/README.md) | v1 (`b6a50ee`) | Installs the PlanetScale CLI |
| [`pnpm/action-setup/v4`](https://github.com/pnpm/action-setup/blob/a7487c7e89a18df4991f7f222e4898a00d66ddda/README.md) | v4.1.0 (`a7487c7`) | Install pnpm package manager |
| [`pnpm/action-setup/v6`](https://github.com/pnpm/action-setup/blob/ea17c68df8912ef543352723c149a84f56e3d413/README.md) | v6.1.0 (`ea17c68`) | Install pnpm package manager |
| [`pnpm/action-setup/viem-wagmi`](https://github.com/pnpm/action-setup/blob/b906affcce14559ad1aafd4ab0e942779e9f58b1/README.md) | v4.3.0 (`b906aff`) | Install pnpm package manager |
| [`preactjs/compressed-size-action/2.8.0`](https://github.com/preactjs/compressed-size-action/blob/946a292cd35bd1088e0d7eb92b69d1a8d5b5d76a/README.md) | 2.8.0 (`946a292`) | Get compressed size differences for every PR |
| [`re-actors/alls-green/v1.2.2`](https://github.com/re-actors/alls-green/blob/05ac9388f0aebcb5727afa17fcccfecd6f8ec5fe/README.md) | v1.2.2 (`05ac938`) | GitHub Action for checking that the test matrix jobs are all successful before proceeding. To be used in branch protection |
| [`rust-lang/crates-io-auth-action/rev-3268eb413133`](https://github.com/rust-lang/crates-io-auth-action/blob/3268eb413133e2960fa4ae0e963ca76380c54cd9/README.md) | v1.0.6 (`3268eb4`) | Retrieve a temporary crates.io access token using trusted publishing. |
| [`stefanzweifel/git-auto-commit-action/v6.0.1`](https://github.com/stefanzweifel/git-auto-commit-action/blob/778341af668090896ca464160c2def5d1d1a3eb0/README.md) | v6.0.1 (`778341a`) | Automatically commits files which have been changed during the workflow run and push changes back to remote repository. |
| [`taiki-e/install-action/v2.86.1`](https://github.com/taiki-e/install-action/blob/288e746965032cfcc232e09af2daf5f23c14d780/README.md) | v2.86.1 (`288e746`) | GitHub Action for installing development tools |
| [`zizmorcore/zizmor-action/v0.5.4`](https://github.com/zizmorcore/zizmor-action/blob/b572f7b1a1c2d41efaab43d504f68d215c3cd727/README.md) | v0.5.4 (`b572f7b`) | Run zizmor from GitHub Actions 🌈 |
| [`zizmorcore/zizmor-action/v0.7.0`](https://github.com/zizmorcore/zizmor-action/blob/f9597c869b2e67095f9b527070297a13a6efe928/README.md) | v0.7.0 (`f9597c8`) | Run zizmor from GitHub Actions 🌈 |
<!-- vendored-actions:end -->

See [vendor/README.md](vendor/README.md) for imports, verification, updates, and
the STS rollout prerequisites. Vendoring controls when upstream code changes enter
our workflows; it does not sandbox actions or eliminate vulnerabilities in a pinned
version. Other third-party actions are not yet migrated, so org-wide enforcement
must wait. The issue-labeled workflow uses the runner's GitHub CLI to post the
reproduction request and close the issue as `not_planned`, with `issues: write`
permission.
