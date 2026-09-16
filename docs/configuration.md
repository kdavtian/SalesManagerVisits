# Configuration

All configuration is environment variables, read from `.env` locally
(via `dotenv`) or from the droplet's `.env` in production (sourced by
`deploy/deploy.sh`, injected into the `app` container by
`docker-compose.yml`). `.env.example` is the source of truth for the full
list with inline comments — this doc groups them by purpose and says
what actually breaks (or doesn't) if each is left unset. **Never commit a
real `.env`** — it's gitignored, and `.env.example` must stay free of
real secrets.

## Required — the app refuses to start without these

| Variable | Purpose | Notes |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | `postgres://user:pass@host:5432/dbname`. |
| `JWT_SECRET` | Signs session cookies | Must be ≥16 characters — `server/src/app.js` refuses to boot otherwise. Generate with `openssl rand -base64 32`. Rotating this logs out every active session. |

## Required for production, optional locally

| Variable | Purpose | Notes |
|---|---|---|
| `NODE_ENV` | `development` locally, `production` on the droplet | Gates the session/CSRF cookies' `secure` flag (only sent over HTTPS when `production`) and a few other prod-only behaviors. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Configures the `db` container and the `app` container's own `DATABASE_URL` | Only `POSTGRES_PASSWORD` needs to be strong in production — `deploy/deploy.sh` refuses to deploy if it's still the `fieldvisits` default. |

## Optional — feature-gated, nothing breaks if unset

Each of these disables one specific feature cleanly (no error, the
relevant UI/endpoint just doesn't appear or 401s) rather than crashing —
by design, so a droplet missing one optional integration still runs
everything else.

| Variable | Enables | If unset |
|---|---|---|
| `ERP_SYNC_KEY` | The three `/api/erp-sync*` endpoints (see [`erp-integration.md`](erp-integration.md)) | Endpoints reject every request. No ERP data flows in. |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_NOTIFY_CHAT_IDS` | Telegram alerts (order placed, plan pending review, large payment collected) | Notifications silently skipped, nothing else affected. Both must be set together (`TELEGRAM_NOTIFY_CHAT_IDS` is comma-separated chat IDs). |
| `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` | Web Push to a rep's own device | Both unset: the push-notification toggle in Settings doesn't appear. Generate a pair with `npx web-push generate-vapid-keys` (run from `server/`). |
| `VAPID_SUBJECT` | Push protocol requirement (a `mailto:` contact) | Defaults to a placeholder in `.env.example`; set to a real address before relying on push in production. |

## Other

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port the server listens on | `3000` |
| `UPLOAD_DIR` | Where check-in photos/POD signatures are written | `./uploads` (Docker volume in production) |
| `CHECKIN_RADIUS_METERS` | Server-side GPS proximity check tolerance for a check-in | `200` |

## Secret handling

- No secrets manager — see risk **R-09** in
  [`governance/risk-and-technical-debt-register.md`](governance/risk-and-technical-debt-register.md).
  Secrets live in the droplet's `.env` file.
- `deploy/deploy.sh` validates `JWT_SECRET` and `POSTGRES_PASSWORD` before
  deploying, refusing to proceed with a missing/weak/default value.
- See [`../SECURITY.md`](../SECURITY.md) for the rotation situation.

## Where these are consumed

- `server/src/app.js` — the required-variable boot check, CSP/security
  headers, CORS-free-by-design posture.
- `server/src/middleware/auth.js`, `csrf.js` — `JWT_SECRET`, cookie flags.
- `server/src/routes/erpSync.js` — `ERP_SYNC_KEY`.
- `server/src/notifications.js` (Telegram/push dispatch) — the
  `TELEGRAM_*`/`VAPID_*` variables.
- `docker-compose.yml` — `POSTGRES_*` for the `db` service.
