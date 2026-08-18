# AGENTS.md

## Scope

These rules apply to the complete `TradeJS-Deploy` repository.

## Purpose

This repository owns server orchestration: SSH deployment, Compose, TLS,
persistent volumes, infrastructure containers, and server-only secrets.

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
- Keep the research-agent image in `TradeJS`, but route strategy edits and pull
  requests to the standalone strategy repositories on their `main` branches.

## Verification

Run `yarn checks` before every commit. For Compose changes, also run
`docker compose -f docker-compose.prod.yml config` with a secret-free local env
when practical.
