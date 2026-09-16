# Local development

## Prerequisites

- Node.js 20+
- Docker (for Postgres locally)
- `npm`

## Five-minute setup

```bash
git clone <repo-url>
cd SalesManagerVisits
cp .env.example .env              # fill in JWT_SECRET at minimum — see configuration.md
docker compose up -d db           # starts Postgres only
cd server
npm install
npm run migrate                   # applies every migrations/*.sql in order
npm run seed                      # creates the initial admin user (prints credentials)
npm run dev                       # starts the API + serves client/public, with --watch
```

Open `http://localhost:3000` and log in with the credentials `npm run
seed` printed.

If anything above fails, it's almost always one of:
- Docker's `db` container isn't actually up yet (`docker compose ps`,
  `docker compose logs db`).
- `.env`'s `DATABASE_URL` doesn't match what `docker-compose.yml` exposes
  (default: `postgres://fieldvisits:fieldvisits@localhost:5432/fieldvisits`).
- `JWT_SECRET` unset or too short — `npm run dev`/tests refuse to start
  below 16 characters (mirrors the same guard `deploy/deploy.sh` uses in
  production). Generate one with `openssl rand -base64 32`.

## Running checks

```bash
cd server
npm test               # integration + unit suite (node:test, real Postgres)
npm run verify:ui       # static UI-regression checks (no browser)
npm run test:e2e:smoke  # Playwright, @smoke-tagged specs only (needs a browser install)
npm run test:e2e        # full Playwright suite (slower; this is what runs nightly in CI)
```

`npm test` needs the same `DATABASE_URL` as above — it runs real queries
against your local Postgres, not a mock. It truncates/reseeds tables it
touches; don't point it at anything you care about.

Playwright needs a matching browser build:
```bash
npx playwright install --with-deps chromium
```

## Project layout

```
server/           Express API
  src/
    routes/        API route handlers (one file per resource area)
    db/            Postgres pool + migration runner
  migrations/       SQL migration files, applied in order
  test/             node:test integration/unit suite
  test/e2e/         Playwright browser suite
  uploads/          Uploaded check-in photos (gitignored, Docker volume in prod)
client/            Static frontend served by the server (no build step)
  public/
    js/views/       One file per screen
    js/app.js       Router/app shell
    sw.js           Service worker (offline caching, PWA install, update delivery)
docs/              This documentation tree
docs/governance/   Architecture snapshot, risk register, process docs
deploy/            Production deploy script + droplet setup walkthrough
```

## Day-to-day workflow

See [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for the branch → PR → CI →
merge workflow, and
[`../CLAUDE.md`](../CLAUDE.md) for the mandatory `APP_VERSION`/
`CACHE_VERSION` bump rule on any change under `client/public/`.

## Where to look next

- [`configuration.md`](configuration.md) — every environment variable.
- [`data-model.md`](data-model.md) — the schema.
- [`roles-permissions.md`](roles-permissions.md) — what each role can do
  (useful for picking which seeded/test account to log in as).
- [`api/README.md`](api/README.md) — API conventions.
