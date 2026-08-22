#!/usr/bin/env bash
# Simple deploy script — run this ON THE DROPLET from inside the repo
# checkout (e.g. /opt/field-visits). Pulls the latest code, rebuilds the
# app image, runs migrations, and restarts the stack.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "Missing .env — copy .env.example to .env and fill it in first." >&2
  exit 1
fi

echo "==> Pulling latest code"
git pull --ff-only

echo "==> Building app image"
docker compose build app

echo "==> Starting database"
docker compose up -d db

echo "==> Waiting for database to accept connections"
until docker compose exec -T db pg_isready -U "${POSTGRES_USER:-fieldvisits}" >/dev/null 2>&1; do
  sleep 1
done

echo "==> Starting app"
docker compose up -d app

echo "==> Running database migrations"
docker compose exec -T app npm run migrate

echo "==> Current status"
docker compose ps

echo
echo "Done. On the very first deploy, also run:"
echo "  docker compose exec app npm run seed"
echo "to create the initial admin account."
