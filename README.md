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
- App tags and Project refs must be immutable commit SHAs; `latest` is rejected for app rollouts.
- Every app image contains `/app/runtime-package-manifest.json`. Deploy stores and compares the old/new manifests so strategy package changes are explicit before a Redis release pointer is switched.
- Production Project images contain only exact stable npm versions. Beta packages
  are exercised in isolated production-like smoke containers; the weekly
  Project composition sync batches promoted `latest` packages into one image
  before Deploy sees any new app SHA.
- The app image supervises Next.js, the signals daemon, and the market WebSocket gateway. The compose healthcheck requires both ports `3000` and `3001` to be healthy, while Nginx proxies `/ws/market` to the gateway with WebSocket upgrade headers.
- Deploy waits for the updated app container to become healthy, prints its logs and fails on timeout/unhealthy status, then validates the running Nginx configuration with `nginx -t`.
- Deployment ensures a persistent 4 GB `/swapfile`, caps the main service containers through Compose memory limits, and keeps runtime signals for three days by default.
- Redis Stack is pinned to `7.4.0-v8`, uses AOF (`everysec`) plus RDB snapshots, and is backed up with a restore drill before deploys and once per day. Backups are retained under `~/backups/redis` for 14 days by default.
- Redis explicitly uses `/data/dump.rdb`, making the named `redisdata` volume the sole persistence location. A deployment is rejected when Redis uses any other persistence path. The persistent-key count must match after Redis is recreated.
- `tradejs.dev` and `docs.tradejs.dev` are published by the separate
  `TradeJS-Site` and `TradeJS-Docs` workflows; this deployment does not pull or
  restart their containers.

## Required Secrets

- `SSH_HOST`
- `SSH_USER`
- `SSH_KEY`
- `GIT_SSH_PRIVATE_KEY`
- `NEXTAUTH_SECRET`
- `PG_PASSWORD`
- `AGENT_GITHUB_TOKEN`
- `REDISINSIGHT_HTPASSWD`

If `Copy deploy files to server` fails with `can't connect without a private SSH key or password`,
`SSH_KEY` is missing, empty, or does not match the server user.

`PG_PASSWORD` is the application database credential. It is injected into both
the app environment and Timescale; every rollout also updates the existing
`app` role, so a persistent database volume does not retain the old checked-in
password. Every installation must provide the repository secret. Generate it
as a URL-safe value without whitespace
or line breaks (for example, `openssl rand -hex 32`) because it is transported
through a Compose env file.

The research-agent SSH key must belong to a machine user that can read
`TradeJS` and write every `TradeJS-Strategy-*` repository. Its GitHub token
needs contents and pull-request read/write access to the same strategy set.
TrendLine and ReverseTrendLine both target `TradeJS-Strategy-TrendLine`.

## Optional Workflow Inputs

Manual deploy supports overriding:

- `image_tag`
- `project_sha`
- `app_changed`
- `agent_changed`
- `ml_infer_changed`

`image_tag` and `project_sha` must be full immutable SHAs. After a strategy package changes, publish the strategy's next Redis `releaseVersion` and switch the deployment reference only after this image is healthy. If rollback is required, first point Redis back to the prior release (paused), then restore the previous image via `release.env.previous`.

## Runtime strategy operations

Use the manual `Runtime strategy config` workflow instead of editing RedisJSON
directly. The only strategy configuration source is the immutable
`users:<user>:strategies:<Strategy>:releases:<releaseVersion>` document. A
deployment stores only the selected `strategyName`, `releaseVersion`, and
`controlState`; the application displays the resolved configuration as
read-only. `verify` is read-only, while `audit` prints only matching Redis key
names and types, never config values. `provision`, `rollout`, `pause`, `resume`,
and `rollback` require `confirm_mutation=true`; each write first creates a Redis
backup and passes a restore drill, then runs `runtime-config verify` against the
selected deployment.
`audit-backups` checksum-verifies the five newest RDB files and prints only
their DBSIZE plus matching runtime/account key names and types. Restore drills require the
snapshot to be newer than the previous `LASTSAVE`, pass `redis-check-rdb`,
match its checksum, and load successfully in an isolated Redis. Live versus
snapshot persistent-key/DBSIZE drift is reported for diagnostics because keys
may change around the BGSAVE fork boundary. A restore that contains no
persistent keys when the source contained any is a hard failure. Restore and
backup-audit containers run as root only inside the disposable isolated
container and mount an individual backup read-only, without making the backup
directory accessible inside the container. Every isolated Redis process
explicitly uses `/data/dump.rdb`; the Redis Stack executable's standalone
default directory is not used. Restore readiness waits up to five minutes for
large snapshots.
If an incoming app is unhealthy, rollback reads the previous full-SHA image tag
from the restored `release.env`, overrides any incoming tag still exported by
the deploy shell, and force-recreates the app container.
`provision` is the one-time operation for an absent deployment. It accepts a
secret-free base64 JSON config, publishes release version 1, creates the
deployment, and leaves new entries paused. Account credentials are never
accepted by this workflow and must already exist through the authenticated
account UI. The selected connector name is also the account provider, avoiding
a second independently configurable binding.
`rollout` applies a secret-free config to an existing versioned deployment. It
does nothing when the resolved config and package versions already match;
otherwise it publishes the next per-strategy release and switches only the
selected strategy pointer to that release in `entries_paused` state. The daemon
observes the changed binding on its next cycle and rebuilds the affected
session; this workflow does not require or perform an app restart.
`pause` and `resume` are the only UI-equivalent operational changes. `rollback`
explicitly moves the deployment pointer to a requested earlier release and
keeps entries paused; it never resolves a missing or invalid release
automatically.

## Local Files

- `.env` is generated in CI from repository secrets.
- Non-secret app values come from `TradeJS-Project/deploy/runtime.env`.
- `release.env` is persisted on the server as the current deployed image state.
- `release-update.env` is generated in CI and only carries the incoming deploy delta.

Keywords: ai, claude, codex.
