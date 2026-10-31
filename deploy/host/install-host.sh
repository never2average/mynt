#!/usr/bin/env bash
# Installs Mynt with its own self-hosted Supabase on a server that already runs Caddy as a system
# service. Prints nothing on success; on failure prints one line naming the log. Secrets are
# generated on the server and never printed. Idempotent: re-run to update.
#   bash install-host.sh <domain> [git-ref]
set -euo pipefail

DOMAIN=${1:?usage: install-host.sh <domain> [git-ref]}
REF=${2:-main}
REPO=https://github.com/never2average/mynt.git
BASE=/opt/mynt
SUPABASE_DIR=/opt/supabase
ENV_DIR=/etc/mynt
COMPANION=/etc/caddy-companion
APP_PORT=3100
DB_PORT=54329      # Supabase Postgres, localhost only
POOLER_PORT=54322  # Supabase pooler, localhost only (5432 may belong to a native Postgres)
LOG=/var/log/mynt/install.log
# An install from before the rename to Mynt, migrated in place and then removed.
OLD_NAME=financial-products-mcp

install -d -m 700 "$(dirname "$LOG")"
exec 3>&2 >>"$LOG" 2>&1
trap 'echo "install failed; details in $LOG" >&3' ERR
echo "=== $(date -Is) install $DOMAIN $REF"

command -v caddy >/dev/null
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'
export DEBIAN_FRONTEND=noninteractive

# --- release -------------------------------------------------------------------------------------
id mynt >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin mynt
mkdir -p "$BASE/releases"
[ -d "$BASE/src/.git" ] || git clone -q "$REPO" "$BASE/src"
git -C "$BASE/src" remote set-url origin "$REPO"
git -C "$BASE/src" fetch -q origin "$REF"
SHA=$(git -C "$BASE/src" rev-parse --short FETCH_HEAD)
REL=$BASE/releases/$SHA
if [ ! -f "$REL/dist/index.js" ]; then
  rm -rf "$REL"
  mkdir -p "$REL"
  git -C "$BASE/src" archive FETCH_HEAD | tar -x -C "$REL"
  (cd "$REL" && npm ci --no-audit --no-fund --loglevel=error && npm prune --omit=dev --no-audit --no-fund --loglevel=error)
fi
chown -R root:root "$REL"

# --- Docker --------------------------------------------------------------------------------------
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable -q --now docker

# --- Supabase ------------------------------------------------------------------------------------
if [ ! -d "$SUPABASE_DIR" ]; then
  tmp=$(mktemp -d)
  git clone -q --depth 1 --filter=blob:none --sparse https://github.com/supabase/supabase "$tmp"
  git -C "$tmp" sparse-checkout set docker
  cp -r "$tmp/docker" "$SUPABASE_DIR"
  rm -rf "$tmp"
fi
cd "$SUPABASE_DIR"
if [ ! -f .env ]; then
  cp .env.example .env
  sh utils/generate-keys.sh --update-env >/dev/null
  rm -f .env.old
  sed -i -e "s|^POOLER_TENANT_ID=.*|POOLER_TENANT_ID=mynt|" .env
fi
# POSTGRES_PORT is also Postgres's port inside its container, so it stays 5432; the host-side ports
# are set separately and used only by the override.
sed -i -e '/^MCP_DB_PORT=/d' -e '/^MCP_POOLER_PORT=/d' -e "s|^POSTGRES_PORT=.*|POSTGRES_PORT=5432|" .env
printf 'MCP_DB_PORT=%s\nMCP_POOLER_PORT=%s\n' "$DB_PORT" "$POOLER_PORT" >>.env
chmod 600 .env
install -m 644 "$REL/deploy/host/supabase.override.yml" docker-compose.override.yml
# Supabase's .env pins COMPOSE_FILE, which stops Compose from loading the override automatically.
# Without the override its ports are published on every interface, past the host firewall.
sed -i -e '/^COMPOSE_FILE=/d' .env
echo "COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml" >>.env
docker compose config | grep -q "published: \"$DB_PORT\""
docker compose pull -q
docker compose up -d --quiet-pull
# Nothing Supabase runs may answer the internet: only SSH, 80 and 443 are public on this server.
public=$(ss -ltnH | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|\[::ffff:127\.)' | sed -E 's/.*:([0-9]+)$/\1/' | sort -un | grep -vxE '22|80|443' || true)
if [ -n "$public" ]; then
  docker compose stop
  echo "refusing: public listener(s) on $public" >&2
  false
fi
for _ in $(seq 150); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' supabase-db 2>/dev/null)" = healthy ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' supabase-db)" = healthy ]

# --- migrate an install from before the rename ---------------------------------------------------
# Keep its database password and Clerk keys, and free its port before the new service starts.
install -d -m 750 -o root -g mynt "$ENV_DIR"
if [ -f "/etc/$OLD_NAME/env" ] && [ ! -f "$ENV_DIR/env" ]; then
  install -m 640 -o root -g mynt "/etc/$OLD_NAME/env" "$ENV_DIR/env"
fi
if [ -f "/etc/systemd/system/$OLD_NAME.service" ]; then
  systemctl disable -q --now "$OLD_NAME" || true
  rm -f "/etc/systemd/system/$OLD_NAME.service"
  systemctl daemon-reload
fi

# --- database role and connection (never printed) ------------------------------------------------
if ! grep -qs '^DB_PASSWORD=' "$ENV_DIR/env"; then
  umask 077
  printf 'DB_PASSWORD=%s\n' "$(openssl rand -hex 24)" >>"$ENV_DIR/env"
fi
DB_PASSWORD=$(grep '^DB_PASSWORD=' "$ENV_DIR/env" | cut -d= -f2)
# Keys the pseudonyms innovators see on product requests; generated once and kept across runs.
if ! grep -qs '^MYNT_PSEUDONYM_SECRET=' "$ENV_DIR/env"; then
  umask 077
  printf 'MYNT_PSEUDONYM_SECRET=%s\n' "$(openssl rand -hex 32)" >>"$ENV_DIR/env"
fi
# Encrypts the customer vault at rest; generated once and kept across runs (losing it loses the vault).
if ! grep -qs '^MYNT_VAULT_KEY=' "$ENV_DIR/env"; then
  umask 077
  printf 'MYNT_VAULT_KEY=%s\n' "$(openssl rand -base64 32)" >>"$ENV_DIR/env"
fi
PGPASSWORD=$(grep '^POSTGRES_PASSWORD=' "$SUPABASE_DIR/.env" | cut -d= -f2-)
export PGPASSWORD
docker exec -i -e PGPASSWORD supabase-db \
  psql -v ON_ERROR_STOP=1 -q -h 127.0.0.1 -U supabase_admin -d postgres -v pw="$DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE financial_products_app LOGIN PASSWORD %L', :'pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'financial_products_app') \gexec
ALTER ROLE financial_products_app PASSWORD :'pw';
CREATE SCHEMA IF NOT EXISTS financial_products AUTHORIZATION financial_products_app;
SQL
unset PGPASSWORD
{
  echo "DB_PASSWORD=$DB_PASSWORD"
  echo "PORT=$APP_PORT"
  echo "DATABASE_URL=postgres://financial_products_app:$DB_PASSWORD@127.0.0.1:$DB_PORT/postgres"
  echo "PUBLIC_URL=https://$DOMAIN"
  # Clerk, boat.dev, model (Anthropic or Vertex AI), GitHub App and hosting (Freestyle) settings are placed in this file separately and kept across runs.
  grep -E '^(MYNT_PSEUDONYM_SECRET|MYNT_VAULT_KEY|CLERK_SECRET_KEY|CLERK_PUBLISHABLE_KEY|MCP_REQUIRE_AUDIENCE|BOAT_API_KEY|ANTHROPIC_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|VERTEX_[A-Z_]+|BD_[A-Z_]+|DESK_[A-Z_]+|REVIEW_[A-Z_]+|BUILD_[A-Z_]+|GITHUB_APP_[A-Z_]+|HOSTING_[A-Z_]+|FREESTYLE_[A-Z_]+)=' "$ENV_DIR/env" || true
} >"$ENV_DIR/env.new"
install -m 640 -o root -g mynt "$ENV_DIR/env.new" "$ENV_DIR/env"
rm -f "$ENV_DIR/env.new"
unset DB_PASSWORD

# --- Mynt service --------------------------------------------------------------------------------
ln -sfn "$REL" "$BASE/current.new"
mv -T "$BASE/current.new" "$BASE/current"
if grep -q '^CLERK_SECRET_KEY=' "$ENV_DIR/env"; then
  # Allowlist, MCP client registration, PKCE and audience claims on the Clerk instance (idempotent).
  (set -a; . "$ENV_DIR/env"; set +a; cd "$REL" && node dist/index.js clerk setup)
fi
install -m 644 "$REL/deploy/host/mynt.service" /etc/systemd/system/mynt.service
systemctl daemon-reload
systemctl enable -q mynt
systemctl restart mynt
for _ in $(seq 30); do curl -fsS "http://127.0.0.1:$APP_PORT/healthz" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS "http://127.0.0.1:$APP_PORT/healthz" >/dev/null

# --- Caddy ---------------------------------------------------------------------------------------
# The main Caddyfile is left untouched (it may be generated by other tooling). Caddy instead runs a
# wrapper that imports it plus this server's companion sites, via a systemd drop-in.
install -d -m 755 "$COMPANION/sites"
rm -f "$COMPANION/sites/$OLD_NAME.caddy"
sed -e "s|@DOMAIN@|$DOMAIN|g" -e "s|@PORT@|$APP_PORT|g" "$REL/deploy/host/site.caddy" >"$COMPANION/sites/mynt.caddy"
printf 'import /etc/caddy/Caddyfile\nimport %s/sites/*.caddy\n' "$COMPANION" >"$COMPANION/Caddyfile"
install -d -m 755 /etc/systemd/system/caddy.service.d
cat >/etc/systemd/system/caddy.service.d/companion-sites.conf <<EOF
[Service]
ExecStart=
ExecStart=/usr/bin/caddy run --environ --config $COMPANION/Caddyfile
ExecReload=
ExecReload=/usr/bin/caddy reload --config $COMPANION/Caddyfile --force
EOF
caddy validate --adapter caddyfile --config "$COMPANION/Caddyfile"
systemctl daemon-reload
systemctl reload caddy

for _ in $(seq 30); do curl -fsS "https://$DOMAIN/healthz" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS "https://$DOMAIN/healthz" >/dev/null

# The new install is healthy: remove what is left of the old one.
rm -rf "/opt/$OLD_NAME" "/etc/$OLD_NAME" "/var/log/$OLD_NAME"
if id fpmcp >/dev/null 2>&1; then userdel fpmcp || true; fi
echo "=== $(date -Is) done $SHA"
