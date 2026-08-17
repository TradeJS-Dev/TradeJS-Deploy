# TradeJS-Deploy

Infrastructure repository for the hosted TradeJS stack.

This repo deploys prebuilt Docker images. It does not build application code
from source and it does not depend directly on npm package publishing.

## Runtime Model

- `TradeJS-Project` builds and pushes:
  - `ghcr.io/tradejs-dev/tradejs-project-app:<project-sha>`
- `TradeJS` continues to build and push:
  - `ghcr.io/tradejs-dev/tradejs-agent:<git-sha>`
  - `ghcr.io/tradejs-dev/tradejs-ml-infer:<git-sha>`
- `TradeJS-Deploy` receives the image tag and immutable Project SHA through
  `repository_dispatch` or `workflow_dispatch`, then reads the secret-free app
  runtime config from that exact Project revision.
- The server pulls only tagged images and runs `docker compose`.
- The app image supervises Next.js, the signals daemon, and the market WebSocket gateway. The compose healthcheck requires both ports `3000` and `3001` to be healthy, while Nginx proxies `/ws/market` to the gateway with WebSocket upgrade headers.
- Deploy waits for the updated app container to become healthy, prints its logs and fails on timeout/unhealthy status, then validates the running Nginx configuration with `nginx -t`.
- Deployment ensures a persistent 4 GB `/swapfile`, caps the main service containers through Compose memory limits, and keeps runtime signals for three days by default.
- `tradejs.dev` and `docs.tradejs.dev` are published by the separate
  `TradeJS-Site` and `TradeJS-Docs` workflows; this deployment does not pull or
  restart their containers.

## Required Secrets

- `SSH_HOST`
- `SSH_USER`
- `SSH_KEY`
- `GIT_SSH_PRIVATE_KEY`
- `NEXTAUTH_SECRET`
- `AGENT_GITHUB_TOKEN`
- `REDISINSIGHT_HTPASSWD`

If `Copy deploy files to server` fails with `can't connect without a private SSH key or password`,
`SSH_KEY` is missing, empty, or does not match the server user.

## Optional Workflow Inputs

Manual deploy supports overriding:

- `image_tag`
- `project_sha`
- `app_changed`
- `agent_changed`
- `ml_infer_changed`

## Local Files

- `.env` is generated in CI from repository secrets.
- Non-secret app values come from `TradeJS-Project/deploy/runtime.env`.
- `release.env` is persisted on the server as the current deployed image state.
- `release-update.env` is generated in CI and only carries the incoming deploy delta.
