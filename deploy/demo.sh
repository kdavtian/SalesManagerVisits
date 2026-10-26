#!/usr/bin/env bash
# Manages the DEMO SITE (docs/demo-site.md): a separate copy of the app with made-up data, its own database and containers.
# Run ON THE SERVER from the repo checkout (e.g. /opt/field-visits). Never touches the real app, its database or its .env.
#
#   ./deploy/demo.sh up                       build, start, migrate and fill the demo (first time: prints the CEO password once)
#   ./deploy/demo.sh update                   git pull, then the same as up (keeps the data and the visitors' logins)
#   ./deploy/demo.sh user <name> [role]       a login for a visitor: <name>@kad.demo, role ceo unless you say another; password printed once
#   ./deploy/demo.sh remove-user <name>       take that login away
#   ./deploy/demo.sh users                    list the logins
#   ./deploy/demo.sh reset                    throw away ALL demo data and logins, start again from a fresh demo
#   ./deploy/demo.sh domain <name>            give it its web address (nginx + free HTTPS certificate), e.g. kadostest.yourcompany.com; as root, after the DNS record exists
#   ./deploy/demo.sh status                   is it running, and does it answer
#   ./deploy/demo.sh down                     stop it (data kept)
#   ./deploy/demo.sh destroy                  stop it and delete its database and uploads
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=".env.demo"
dc() { docker compose -f docker-compose.demo.yml --env-file "$ENV_FILE" "$@"; }

ensure_env() {
  if [ ! -f "$ENV_FILE" ]; then
    umask 077
    {
      echo "# Secrets of the DEMO site only (made by deploy/demo.sh). Not the real app's .env."
      echo "DEMO_DB_PASSWORD=$(openssl rand -hex 16)"
      echo "DEMO_JWT_SECRET=$(openssl rand -base64 32 | tr -d '\n')"
      echo "DEMO_PORT=3100"
    } > "$ENV_FILE"
    echo "==> Created $ENV_FILE with new random secrets"
  fi
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
}

port() { echo "${DEMO_PORT:-3100}"; }

up() {
  ensure_env
  echo "==> Building the demo image"
  dc build app
  echo "==> Starting the demo database"
  dc up -d db
  echo "==> Running migrations on the demo database"
  dc run --rm -T app npm run migrate
  echo "==> Filling the demo with made-up data (only if it is empty)"
  dc run --rm -T app node scripts/demo-site.mjs seed
  echo "==> Starting the demo app"
  dc up -d app
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$(port)/api/health" >/dev/null 2>&1; then
      echo "==> The demo answers on http://127.0.0.1:$(port)  (nginx: see deploy/nginx-demo.conf)"
      return
    fi
    sleep 1
  done
  echo "The demo did not answer in 30 s. Look at: docker compose -p fvdemo logs app" >&2
  exit 1
}

case "${1:-}" in
  up) up ;;
  update)
    git pull --ff-only
    up
    ;;
  user)
    ensure_env
    [ -n "${2:-}" ] || { echo "Usage: $0 user <name> [role]" >&2; exit 1; }
    dc run --rm -T app node scripts/demo-site.mjs add-user "$2" "${3:-ceo}"
    ;;
  remove-user)
    ensure_env
    [ -n "${2:-}" ] || { echo "Usage: $0 remove-user <name>" >&2; exit 1; }
    dc run --rm -T app node scripts/demo-site.mjs remove-user "$2"
    ;;
  users)
    ensure_env
    dc run --rm -T app node scripts/demo-site.mjs list-users
    ;;
  reset)
    ensure_env
    echo "==> Deleting all demo data and logins"
    dc down -v
    up
    ;;
  domain)
    DOMAIN="${2:-}"
    [ -n "$DOMAIN" ] || { echo "Usage: $0 domain <name>   e.g. $0 domain kadostest.yourcompany.com" >&2; exit 1; }
    case "$DOMAIN" in *[!a-zA-Z0-9.-]*|.*|*.) echo "That does not look like a web address: $DOMAIN" >&2; exit 1 ;; esac
    [ "$(id -u)" -eq 0 ] || { echo "Run this as root (sudo ./deploy/demo.sh domain $DOMAIN): it writes the nginx file and asks for the certificate." >&2; exit 1; }
    command -v nginx >/dev/null && command -v certbot >/dev/null || { echo "nginx and certbot must be installed (they are on the real server)." >&2; exit 1; }
    ensure_env
    SITE="/etc/nginx/sites-available/field-visits-demo"
    echo "==> Checking that $DOMAIN points at this server"
    if command -v dig >/dev/null; then
      echo "    $DOMAIN -> $(dig +short "$DOMAIN" | tr '\n' ' ')  (this server: $(curl -fsS https://api.ipify.org 2>/dev/null || echo unknown))"
    fi
    echo "==> Step 1/2: plain web address (for the certificate check)"
    cat > "$SITE" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { proxy_pass http://127.0.0.1:$(port); proxy_set_header Host \$host; }
}
NGINX
    mkdir -p /var/www/certbot
    ln -sf "$SITE" /etc/nginx/sites-enabled/field-visits-demo
    nginx -t && systemctl reload nginx
    echo "==> Step 2/2: free HTTPS certificate (Let's Encrypt)"
    certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email
    sed "s/YOUR_DEMO_DOMAIN/$DOMAIN/g; s/127.0.0.1:3100/127.0.0.1:$(port)/g" deploy/nginx-demo.conf > "$SITE"
    nginx -t && systemctl reload nginx
    echo "==> Done. Open https://$DOMAIN"
    ;;
  status)
    ensure_env
    dc ps
    curl -fsS "http://127.0.0.1:$(port)/api/health" && echo " <- the demo answers" || echo "The demo does not answer"
    ;;
  down)
    ensure_env
    dc down
    ;;
  destroy)
    ensure_env
    dc down -v
    echo "Demo containers, database and uploads deleted. (.env.demo kept; delete it too if you want new secrets.)"
    ;;
  *)
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
