#!/bin/sh

set -eu

COMPOSE="docker compose --env-file .env --env-file release.env -f docker-compose.prod.yml"

echo ">>> Starting nginx without SSL"
$COMPOSE up -d docs nginx

echo ">>> Requesting certificates"
$COMPOSE run --rm certbot

echo ">>> Restarting nginx with SSL"
$COMPOSE restart nginx

echo ">>> Done"
