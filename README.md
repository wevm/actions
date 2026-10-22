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

