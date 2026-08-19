# AGENTS.md

## Scope

These rules apply to the complete `TradeJS-Deploy` repository.

## Purpose

This repository owns server orchestration: SSH deployment, Compose, TLS,
persistent volumes, infrastructure containers, and server-only secrets.

## Workspace Routing

- Start from `~/dev/tradejs/AGENTS.md`; do not scan sibling repositories.
- Use this repository only for production Compose, SSH, TLS, persistent
  volumes, server lifecycle, and secret injection. The app image and personal
  runtime composition belong in `tradejs-project`; engine code belongs in
  `investing`; strategy code belongs in standalone strategy repositories.
- Local Redis/backtests/evidence inspection happens in `tradejs-project`.
  Production inspection must target the actual runtime server and must not be
  inferred from the local project.

## Boundaries

- Deploy the app image published by `TradeJS-Project`, pinned by image tag.
- Fetch `deploy/runtime.env` from the exact dispatched Project SHA.
- Inject application credentials and server secrets here; never commit values.
- Require `PG_PASSWORD` and keep the persistent Timescale `app` role aligned
  with it before starting the application container.
- Keep personal package composition, runtime app Dockerfile, cron, and
  `tradejs.config.ts` in `TradeJS-Project`.
- Keep engine package publishing and ML inference implementation in `TradeJS`.
- Reject any production Project image whose package manifest contains an npm
  prerelease; beta validation belongs to the isolated Project smoke flow.
- Production deployment and full strategy config are read only from the exact
  Project image's `tradejs.config.ts`. Redis may own trading accounts, optional
  pause overrides, audit events, heartbeats, signals, and trades, but never
  deployment/config/release documents.
- Run legacy Redis cleanup only after the new app is healthy and
  `runtime-control verify` succeeds. Require a verified backup/restore drill,
  inventory key names/types, and delete only the cleanup script's allowlist.
- Keep the research-agent image in `TradeJS`, but route strategy edits and pull
  requests to the standalone strategy repositories on their `main` branches.

## Verification

Run `yarn checks` before every commit. For Compose changes, also run
`docker compose -f docker-compose.prod.yml config` with a secret-free local env
when practical.
