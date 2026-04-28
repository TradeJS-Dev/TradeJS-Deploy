# TradeJS-Deploy

Infrastructure repository for the hosted TradeJS stack.

This repo deploys prebuilt Docker images published by `TradeJS`. It does not build
application code from source and it does not depend on npm package publishing.

## Runtime Model

- `TradeJS` builds and pushes:
  - `ghcr.io/tradejs-dev/tradejs-app:<git-sha>`
  - `ghcr.io/tradejs-dev/tradejs-agent:<git-sha>`
  - `ghcr.io/tradejs-dev/tradejs-ml-infer:<git-sha>`
- `TradeJS-Deploy` receives the image tag through `repository_dispatch` or
  `workflow_dispatch`.
- The server pulls only tagged images and runs `docker compose`.

## Required Secrets

- `SSH_HOST`
- `SSH_USER`
- `SSH_KEY`
- `NEXTAUTH_SECRET`
- `AGENT_GITHUB_TOKEN`
- `AGENT_GIT_SSH_KEY`
- `REDISINSIGHT_HTPASSWD`

If `Copy deploy files to server` fails with `can't connect without a private SSH key or password`,
`SSH_KEY` is missing or empty in the repository secrets.

## Optional Workflow Inputs

Manual deploy supports overriding:

- `image_tag`
- `app_changed`
- `agent_changed`
- `ml_infer_changed`

## Local Files

- `.env` is generated in CI from repository secrets.
- `release.env` is persisted on the server as the current deployed image state.
- `release-update.env` is generated in CI and only carries the incoming deploy delta.
