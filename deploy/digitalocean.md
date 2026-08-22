# Deploying to a DigitalOcean droplet

This walks through everything needed to get Field Visits running on a
droplet behind nginx with a real HTTPS certificate. Run the numbered
commands yourself — I don't have SSH access to your droplet, so nothing
here gets executed automatically.

## 0. What you need before starting

- A DigitalOcean droplet running **Ubuntu 22.04 or 24.04**, with SSH access
  (root or a sudo user).
- A **domain or subdomain** you control (e.g. `fieldvisits.yourcompany.com`),
  so Let's Encrypt can issue a certificate. A bare IP address can't get a
  trusted cert.

## 1. Point DNS at the droplet

In your domain's DNS settings, add an **A record**:

| Type | Host                          | Value (droplet's public IPv4) |
| ---- | ----------------------------- | ------------------------------ |
| A    | `fieldvisits` (or `@`)        | `YOUR_DROPLET_IP`               |

Wait for it to propagate (`dig fieldvisits.yourcompany.com` should return
the droplet's IP — usually a few minutes, sometimes longer).

## 2. SSH in and install prerequisites

```bash
ssh root@YOUR_DROPLET_IP
```

```bash
apt update && apt upgrade -y

# Docker + Compose plugin
curl -fsSL https://get.docker.com | sh

# nginx + certbot
apt install -y nginx certbot
```

## 3. Clone the repo

```bash
mkdir -p /opt && cd /opt
git clone https://github.com/kdavtian/SalesManagerVisits.git field-visits
cd field-visits
```

(If the repo is private, you'll need to authenticate — either clone over
SSH with a deploy key, or use a GitHub personal access token in the HTTPS
URL.)

## 4. Configure environment variables

```bash
cp .env.example .env
nano .env
```

At minimum, change:

- `JWT_SECRET` — a long random string (`openssl rand -base64 48` works well)
- `POSTGRES_PASSWORD` — a strong password (not the `fieldvisits` default)

Leave `DATABASE_URL` as-is — it's only used for local (non-Docker) dev;
`docker-compose.yml` builds the container's own `DATABASE_URL` from the
`POSTGRES_*` vars.

## 5. First-time deploy

```bash
./deploy/deploy.sh
```

This builds the app image, starts Postgres, waits for it to be ready,
starts the app, and runs migrations. The app is now listening on
`127.0.0.1:3000` (not yet publicly reachable — that's what nginx is for).

Create the initial admin account:

```bash
docker compose exec app npm run seed
```

By default this creates `admin@example.com` / `changeme123` — override
with `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME`:

```bash
docker compose exec -e SEED_ADMIN_EMAIL=you@company.com \
  -e SEED_ADMIN_PASSWORD='a-strong-password' \
  -e SEED_ADMIN_NAME='Your Name' \
  app npm run seed
```

**Change this password after your first login.**

## 6. Set up nginx (HTTP first, so Certbot can verify the domain)

```bash
mkdir -p /var/www/certbot
cp deploy/nginx.conf /etc/nginx/sites-available/field-visits
sed -i 's/YOUR_DOMAIN/fieldvisits.yourcompany.com/g' /etc/nginx/sites-available/field-visits
```

Before the HTTPS server block will work, you need a certificate — but
nginx won't start with `ssl_certificate` pointing at files that don't
exist yet. Temporarily comment out the second (`listen 443`) server block
in `/etc/nginx/sites-available/field-visits`, then:

```bash
ln -s /etc/nginx/sites-available/field-visits /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

## 7. Get a certificate

```bash
certbot certonly --webroot -w /var/www/certbot \
  -d fieldvisits.yourcompany.com
```

Follow the prompts (email address, terms of service). Certbot installs a
cron/systemd timer for automatic renewal — no further action needed there.

## 8. Enable HTTPS

Uncomment the `listen 443` server block you commented out in step 6, then:

```bash
nginx -t && systemctl reload nginx
```

Visit `https://fieldvisits.yourcompany.com` — you should see the Field
Visits login screen with a valid padlock.

## 9. Subsequent deploys

From then on, deploying a new version is just:

```bash
cd /opt/field-visits
./deploy/deploy.sh
```

## Notes

- **Uploaded photos** live in the `uploads_data` Docker volume, so they
  survive container rebuilds/restarts. Back it up with
  `docker run --rm -v field-visits_uploads_data:/data -v $(pwd):/backup alpine tar czf /backup/uploads-backup.tar.gz -C /data .`
  if you want an off-droplet copy.
- **Database backups**: `docker compose exec db pg_dump -U fieldvisits fieldvisits > backup.sql`
- The app only binds to `127.0.0.1:3000` (see `docker-compose.yml`), so it's
  only reachable through nginx — not directly from the internet.
