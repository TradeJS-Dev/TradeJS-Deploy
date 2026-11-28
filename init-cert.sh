#!/bin/sh

set -eu

if [ -f .server-ingress ]; then
  echo "Caddy manages certificates in server ingress mode." >&2
  exit 1
fi

COMPOSE="docker compose --env-file .env --env-file release.env -f docker-compose.prod.yml"

echo ">>> Starting nginx without SSL"
$COMPOSE up -d docs nginx

echo ">>> Requesting certificates"
$COMPOSE run --rm certbot

echo ">>> Restarting nginx with SSL"
$COMPOSE restart nginx

echo ">>> Done"
