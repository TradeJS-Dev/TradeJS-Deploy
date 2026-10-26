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
- `TradeJS-Deploy` receives one immutable Project SHA through
  `repository_dispatch` or `workflow_dispatch`. That SHA is also the app image
  tag, so two independently supplied values cannot drift.
- The server pulls only tagged images and runs `docker compose`.
- App, Project, agent, ml-infer, site, and docs refs are all full immutable Git
  SHAs. `release.env` is a complete declaration and rejects missing or mutable
  refs.
- Every app image contains `/app/runtime-package-manifest.json`. Deploy stores
  and compares old/new manifests so package changes are explicit alongside the
  Git-owned computed `strategyRevision` and `deploymentCompositionId` changes.
- Production Project images contain one exact framework cohort: either a
  canonical stable version or one verified `x.y.z-beta.N` version shared by
  every framework package. Base, Strategy Kit, and strategy packages remain
  exact and stable-only. Deploy rejects mixed framework versions and every
  other prerelease shape.
- The app image supervises Next.js, the signals daemon, and the market WebSocket gateway. The compose healthcheck requires both ports `3000` and `3001` to be healthy, while Nginx proxies `/ws/market` to the gateway with WebSocket upgrade headers.
- Deploy waits for the updated app container to become healthy, runs
  `runtime-control verify`, prints logs and rolls back both the app image and
  runtime env on failure, then validates Nginx with `nginx -t`.
- A successful app rollout seals a verification receipt in
  `data/runtime-verification/<user>/<deployment>/<Project SHA>/<composition>/`.
  It includes the exact package manifest, the digest observed from the running
  container image, container health, strategy revisions and `runtime-control verify`.
  `capture-runtime-verification.sh observe` refreshes the observation every five
  minutes without changing the original `deploymentVerifiedAt`. Observations
  without a deploy receipt keep that timestamp unknown. MCP exposes the report
  through read-only `runtime_get_verification`; `fresh=false` or a failed capture
  is insufficient for promotion. The collector owns Docker access; MCP does not.
- Deployment ensures a persistent 4 GB `/swapfile`, caps the main service containers through Compose memory limits, and keeps runtime signals for three days by default.
- After the daily runtime-evidence window closes, the server replays that
  window with the exact image digest recorded by the evidence bundle. The
  replay runs with a read-only Timescale role, an isolated Redis instance,
  bounded resources, and no exchange-facing transport; its image lease is
  retained until the feedback artifact is collected.
- Redis Stack is pinned to `7.4.0-v8`, uses AOF (`everysec`) plus RDB snapshots, and is backed up with a restore drill before deploys and once per day. Backups are retained under `~/backups/redis` for 14 days by default.
- Redis explicitly uses `/data/dump.rdb`, making the named `redisdata` volume the sole persistence location. A deployment is rejected when Redis uses any other persistence path. The persistent-key count must match after Redis is recreated.
- `TradeJS-Site` and `TradeJS-Docs` publish full-SHA images without server
  credentials. Their production rollout happens only through Deploy's typed
  component workflow.

## MCP replay worker

The optional `mcp` Compose profile runs `mcp-worker` from the exact app image
with its own resource limits and isolated replay Redis. The worker has no Docker
socket or SSH credentials. It submits a sealed request under the shared
`data/mcp-replay-requests` directory; the Deploy-owned `mcp-replay-host.py`
runner validates the artifact and checksum, then executes replay with the
producer image recorded in the evidence.

`install-runtime-feedback-cron.sh` installs the host runner every minute.
A missing runner heartbeat or one older than two minutes prevents a new replay.
Host interruption, cancellation and timeout fail the request without automatic
retry. Results and host logs remain beside the request. An MCP replay neither
sends a notification nor adds the artifact to the scheduled notification queue;
the daily feedback process keeps ownership of its own completion and notification
markers.

## Docker Maintenance

Run the `Docker Maintenance` workflow to remove old images and expired replay
lease containers. Set `dry_run` to preview the exact list without deleting
Docker objects. The server requires Python 3. The workflow shares the deployment
queue, so cleanup cannot overlap a deployment started through this repository.

Cleanup preserves images referenced by any remaining container, every image in
`release.env` and `release.env.previous` when present, and the two newest images
with full-SHA tags for each TradeJS component. Images younger than 24 hours and
tagged images outside the five TradeJS component repositories are retained.
Missing or invalid release state, or a declared image missing locally, stops
cleanup before deletion. Release files are parsed as data, never executed.

Only stopped replay lease containers with a valid, positive expiry in the past
are removed. Lease expiry and image references are checked again before each
removal. Changes to release state or image tags stop cleanup. Docker removal
uses neither force nor volume deletion. The workflow does not modify databases,
backups, logs, runtime evidence, or deployment configuration.

The job prints its plan, deleted objects, actual change in available disk space,
and verifies that running containers kept their image, start time, restart count,
and healthy status. Local execution on the server uses the same entrypoint:

```bash
~/scripts/docker-image-prune.sh --dry-run
~/scripts/docker-image-prune.sh
```

## Required Secrets

Make every value below available to `TradeJS-Deploy` as a repository secret or
an organization secret explicitly granted to this repository. Do not store
these credentials in TradeJS, TradeJS-Project, or package repositories. Deploy,
backup, runtime-control, and maintenance jobs read these scopes directly;
GitHub Environments are not used while there is no approval or branch gate.

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
password. Every installation must provide `PG_PASSWORD` as a Deploy-owned
GitHub Actions secret; the workflow never recovers it from an existing server
`.env`. Generate it
as a URL-safe value without whitespace
or line breaks (for example, `openssl rand -hex 32`) because it is transported
through a Compose env file.

The research-agent SSH key must belong to a machine user that can read
`TradeJS` and write every `TradeJS-Strategy-*` repository. Its GitHub token
needs contents and pull-request read/write access to the same strategy set.
TrendLine and ReverseTrendLine both target `TradeJS-Strategy-TrendLine`.

## Deployment Workflows

- `Deploy Project app` accepts only `project_sha`; the app tag is derived from
  the same SHA and no unrelated service is reconciled.
- `Deploy production component` accepts a typed `agent`, `ml-infer`, `site`, or
  `docs` component plus its exact source/image SHA.
- `Initialize complete production release` accepts all five source SHAs and is
  the only workflow allowed to reconcile infrastructure and every service.

Run initialization once after adopting the complete release-state contract.
After that, routine workflows update exactly one component. Strategy packages
and full config remain committed together in the Project revision; there is no
Redis release pointer.

## Runtime strategy operations

Use the manual `Runtime strategy control` workflow. The only strategy
configuration source is the exact Project image's `tradejs.config.ts`; the
application displays it read-only. `verify` validates the declaration, installed
package manifest, and server-owned account binding. `pause` and `resume` are the
only routine mutations and affect only optional
`users:<user>:runtime:controls` overrides. Selecting the mutation is sufficient;
every mutation creates a Redis backup, passes a restore drill, and re-runs
`runtime-control verify`.
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

- `.env` is generated in CI from GitHub Actions secrets owned by or explicitly
  granted to `TradeJS-Deploy`.
- Non-secret app values come from `TradeJS-Project/deploy/runtime.env`.
- `release.env` is persisted on the server as the complete exact release state.
- `runtime.env.incoming` is generated in CI for an app rollout and replaces
  `.env` atomically while retaining `.env.previous` for rollback.

Keywords: ai, claude, codex.
