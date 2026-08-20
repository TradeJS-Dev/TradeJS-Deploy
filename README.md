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
- Every app image contains `/app/runtime-package-manifest.json`. Deploy stores
  and compares old/new manifests so package changes are explicit alongside the
  Git-owned computed `strategyRevision` and `deploymentCompositionId` changes.
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

Store every value below in the protected `production` GitHub environment of
`TradeJS-Deploy`, not in TradeJS, TradeJS-Project, package repositories, or
repository-wide secrets. Deploy, backup, runtime-control, and maintenance jobs
all bind that environment before reading credentials.

- `SSH_HOST`
- `SSH_USER`
- `SSH_KEY`
- `GIT_SSH_PRIVATE_KEY`
- `NEXTAUTH_SECRET`
- `PG_PASSWORD`
- `AGENT_GITHUB_TOKEN`
- `REDISINSIGHT_HTPASSWD`
- `COINALYZE_API_KEY` — injected into the app and synchronized into the root
  Redis user record after backup and health verification; the value is never
  printed by the deploy workflow.

If `Copy deploy files to server` fails with `can't connect without a private SSH key or password`,
`SSH_KEY` is missing, empty, or does not match the server user.

`PG_PASSWORD` is the application database credential. It is injected into both
the app environment and Timescale; every rollout also updates the existing
`app` role, so a persistent database volume does not retain the old checked-in
password. Every installation must provide the `production` environment secret;
the workflow never recovers it from an existing server `.env`. Generate it
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

`image_tag` and `project_sha` must be full immutable SHAs. Strategy packages and
full config are committed together in the Project revision; runtime validation
computes the strategy and deployment composition identifiers. If rollback is
required, optionally pause entries and restore the previous image via
`release.env.previous`; there is no Redis release pointer.

## Runtime strategy operations

Use the manual `Runtime strategy control` workflow. The only strategy
configuration source is the exact Project image's `tradejs.config.ts`; the
application displays it read-only. `verify` validates the declaration, installed
package manifest, and server-owned account binding. `pause` and `resume` are the
only routine mutations and affect only optional
`users:<user>:runtime:controls` overrides. Each mutation requires
`confirm_mutation=true`, creates a Redis backup, passes a restore drill, and
re-runs `runtime-control verify`.
`audit-backups` checksum-verifies the five newest RDB files and prints their
DBSIZE without reading values. Restore drills require the
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
`cleanup-legacy` is a one-time post-migration action. It first verifies the
healthy Git-owned runtime, performs a verified backup/restore drill, inventories
only key names/types, and deletes the allowlisted obsolete
`users:<user>:strategies*` namespace plus old deployment documents. It preserves
new deployment heartbeats, controls, control-event audit records, accounts,
signals, evaluations, and trades. The backup is the recovery path.

## Local Files

- `.env` is generated in CI from `TradeJS-Deploy`'s protected `production`
  environment secrets.
- Non-secret app values come from `TradeJS-Project/deploy/runtime.env`.
- `release.env` is persisted on the server as the current deployed image state.
- `release-update.env` is generated in CI and only carries the incoming deploy delta.

Keywords: ai, claude, codex.
