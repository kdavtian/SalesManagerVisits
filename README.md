# Field Visits

Installable PWA for field sales managers. Managers check in at customer
workshops/garages from a map; the server verifies GPS proximity, stores an
optional photo and note. Admins get a dashboard of who visited whom, when,
and whether the location matched.

## Status

Early scaffold — see the build order below for progress. Not yet deployed.

## Stack

- **Backend:** Node.js + Express, REST API
- **Database:** PostgreSQL (via Docker)
- **File storage:** local disk under a Docker volume (`server/uploads`),
  structured to allow swapping in S3-compatible object storage later
- **Frontend:** Vanilla JS, static bundle served by Express
- **Maps:** Leaflet.js + OpenStreetMap tiles (no API key required)
- **Auth:** email + password (bcrypt) with a signed session cookie/JWT
- **PWA:** manifest + service worker, Android install prompt, guided iOS
  "Add to Home Screen" walkthrough

## Repo layout

```
server/           Express API
  src/
    routes/       API route handlers
    db/           Postgres pool + query helpers
  migrations/      SQL migration files
  uploads/         Uploaded check-in photos (gitignored, Docker volume in prod)
client/           Static frontend served by the server
  public/         manifest.json, icons, service worker, index.html
  src/            app JS (map view, CRM, check-in flow, dashboard)
```

## Local development

Prerequisites: Node.js 20+, Docker (for Postgres), `npm`.

```bash
cp .env.example .env          # fill in JWT_SECRET, etc.
docker compose up -d db       # starts Postgres only, for local dev
cd server && npm install
npm run migrate               # applies migrations/*.sql
npm run seed                  # creates the initial admin user
npm run dev                   # starts the API + serves client/public
```

Then open http://localhost:3000.

## Environment variables

See `.env.example`. At minimum you need `DATABASE_URL` and `JWT_SECRET` set
for local development.

## Deployment

Docker Compose (app + Postgres) behind nginx with Let's Encrypt on a
DigitalOcean droplet. Deployment docs and scripts land in `deploy/` once the
app is feature-complete locally (see build order below).

## Build order

1. [x] Repo scaffold, `.gitignore`, README
2. [ ] Backend: Express app, Postgres connection, migrations, auth, seed script
3. [ ] Customers + check-ins CRUD, server-side GPS distance calc, photo upload
4. [ ] Frontend: login, map view, customer list, check-in flow, dashboard
5. [ ] PWA layer: manifest, icons, service worker, install prompt/walkthrough
6. [ ] Dockerize: Dockerfile, docker-compose.yml, nginx + HTTPS config
7. [ ] Deployment docs/script for the DigitalOcean droplet
