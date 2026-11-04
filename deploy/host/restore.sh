#!/usr/bin/env bash
# Restores a backup made by backup.sh.
#   bash restore.sh --test <backup-dir> [--identity <age-identity-file>]
#       Restores into a throwaway Postgres container (no network, removed afterwards), prints how many tables
#       each key schema has and how many files the Storage archive holds. Production is not touched.
#   bash restore.sh --yes-replace-production <backup-dir> [--identity <age-identity-file>]
#       REPLACES every database in Supabase's Postgres and Supabase's Storage files with the backup's. Mynt and
#       Supabase's other services are stopped meanwhile. A safety backup of the current state is taken first.
# <backup-dir> is a local backup (/var/backups/mynt/<time>) or an off-site one downloaded with rclone; an off-site
# one is encrypted (*.age) and is decrypted with the operator's age identity file, which never stays on the server.
# Settings: the same variables as backup.sh (SUPABASE_DIR, BACKUP_DB_CONTAINER, BACKUP_DB_USER, BACKUP_STORAGE_DIR),
# plus BACKUP_TEST_IMAGE (default postgres:17), BACKUP_VERIFY_SCHEMAS (default "financial_products auth storage
# public"), BACKUP_DB_SERVICE (Supabase's Compose service for Postgres, default db) and MYNT_SERVICE (default mynt).
set -euo pipefail
umask 077

ENV_FILE=${MYNT_BACKUP_ENV_FILE:-/etc/mynt/backup.env}
# KEY=value lines, taken literally (never run as shell); a variable already in the environment wins.
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    key=${line%%=*}
    [[ "$line" == *=* && "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [ -z "${!key+x}" ] || continue
    value=${line#*=}
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value=${BASH_REMATCH[1]}; fi
    export "$key=$value"
  done <"$ENV_FILE"
  unset line key value
fi
SUPABASE_DIR=${SUPABASE_DIR:-/opt/supabase}
DB_CONTAINER=${BACKUP_DB_CONTAINER:-supabase-db}
DB_USER=${BACKUP_DB_USER:-postgres}
DB_SERVICE=${BACKUP_DB_SERVICE:-db}
STORAGE_DIR=${BACKUP_STORAGE_DIR:-$SUPABASE_DIR/volumes/storage}
TEST_IMAGE=${BACKUP_TEST_IMAGE:-postgres:17}
SCHEMAS=${BACKUP_VERIFY_SCHEMAS:-financial_products auth storage public}
MYNT_SERVICE=${MYNT_SERVICE:-mynt}
HERE=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)

usage() { echo "usage: restore.sh (--test | --yes-replace-production) <backup-dir> [--identity <age-identity-file>]" >&2; exit 2; }
MODE="" SRC="" IDENTITY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --test) MODE="test" ;;
    --yes-replace-production) MODE=production ;;
    --identity) IDENTITY=${2:?--identity needs a file}; shift ;;
    -*) usage ;;
    *) SRC=$1 ;;
  esac
  shift
done
[ -n "$MODE" ] && [ -n "$SRC" ] || usage
[ -d "$SRC" ] || { echo "no such backup directory: $SRC" >&2; exit 1; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/mynt-restore.XXXXXX")
NAME=""
cleanup() {
  if [ -n "$NAME" ]; then docker rm -f "$NAME" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- the backup's files, decrypted if they came from off-site, and checked against their checksums ------
for f in db.sql.gz storage.tar.gz SHA256SUMS; do
  if [ -f "$SRC/$f" ]; then
    ln -s "$(readlink -f "$SRC/$f")" "$WORK/$f"
  elif [ -f "$SRC/$f.age" ]; then
    [ -n "$IDENTITY" ] || { echo "$SRC holds encrypted files: pass --identity <your age identity file>" >&2; exit 1; }
    age -d -i "$IDENTITY" -o "$WORK/$f" "$SRC/$f.age"
  fi
done
[ -f "$WORK/db.sql.gz" ] || { echo "no db.sql.gz (or db.sql.gz.age) in $SRC" >&2; exit 1; }
if [ -f "$WORK/SHA256SUMS" ]; then
  (cd "$WORK" && sha256sum --quiet --ignore-missing -c SHA256SUMS) || { echo "checksums don't match: the backup is damaged" >&2; exit 1; }
fi
gzip -t "$WORK/db.sql.gz"
[ ! -f "$WORK/storage.tar.gz" ] || gzip -t "$WORK/storage.tar.gz"

# The dump drops and recreates every database, template1 and postgres included, so it is replayed from a scratch
# database that it doesn't touch.
SCRATCH=mynt_restore_scratch

# Tables per key schema, printed one per line: "table_count <schema> <n>".
count_tables() { # <container> <psql args...>
  local c=$1; shift
  docker exec -i -e PGPASSWORD "$c" psql -X -A -t -F ' ' -v ON_ERROR_STOP=1 -v schemas="$SCHEMAS" "$@" <<'SQL'
SELECT 'table_count', s, (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                          WHERE n.nspname = s AND c.relkind IN ('r', 'p'))
  FROM unnest(string_to_array(:'schemas', ' ')) AS s;
SQL
}

# --- test: a throwaway container, nothing else touched --------------------------------------------------
if [ "$MODE" = test ]; then
  NAME=mynt-restore-test-$$-$RANDOM
  docker run -d --rm --name "$NAME" --network none -e POSTGRES_HOST_AUTH_METHOD=trust "$TEST_IMAGE" >/dev/null
  # TCP answers only once initdb has finished and the real server is up.
  for _ in $(seq 90); do docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U postgres && break; sleep 1; done
  docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U postgres
  docker exec "$NAME" psql -X -q -h 127.0.0.1 -U postgres -d postgres -c "CREATE DATABASE $SCRATCH"
  # A vanilla Postgres lacks some of Supabase's extensions, so some statements fail; the tables must still come back.
  gunzip -c "$WORK/db.sql.gz" | docker exec -i "$NAME" psql -X -q -h 127.0.0.1 -U postgres -d "$SCRATCH" >/dev/null 2>"$WORK/errors" || true
  echo "restore_errors $(grep -c 'ERROR' "$WORK/errors" || true)"
  counts=$(count_tables "$NAME" -h 127.0.0.1 -U postgres -d postgres)
  echo "$counts"
  if [ -f "$WORK/storage.tar.gz" ]; then echo "storage_files $(tar -tzf "$WORK/storage.tar.gz" | grep -vc '/$' || true)"; fi
  n=$(echo "$counts" | awk '$2 == "financial_products" { print $3 }')
  [ "${n:-0}" -gt 0 ] || { echo "the restored database has no financial_products tables" >&2; exit 1; }
  exit 0
fi

# --- production ------------------------------------------------------------------------------------------
echo "Replacing every database in $DB_CONTAINER and the files in $STORAGE_DIR with the backup in $SRC."
echo "Mynt and Supabase's other services stop until it's done. Taking a safety backup of the current state first."
if [ -t 0 ]; then echo "Starting in 15 seconds; press Ctrl-C to stop."; sleep 15; fi
bash "$HERE/backup.sh" || { echo "the safety backup failed; nothing was changed" >&2; exit 1; }
echo "Safety backup: $(find "${BACKUP_DIR:-/var/backups/mynt}" -mindepth 1 -maxdepth 1 -type d -name '20*Z' -printf '%f\n' | LC_ALL=C sort | tail -n 1)"

if [ -r "$SUPABASE_DIR/.env" ] && grep -q '^POSTGRES_PASSWORD=' "$SUPABASE_DIR/.env"; then
  PGPASSWORD=$(grep '^POSTGRES_PASSWORD=' "$SUPABASE_DIR/.env" | cut -d= -f2-)
  export PGPASSWORD
fi
# A full dump and restore need a superuser; some Supabase images make "postgres" an ordinary role, and then the
# image's own superuser, supabase_admin, is used (same password).
if [ "$(docker exec -e PGPASSWORD "$DB_CONTAINER" psql -X -A -t -h 127.0.0.1 -U "$DB_USER" -d postgres -c 'SELECT rolsuper FROM pg_roles WHERE rolname = current_user' 2>/dev/null)" != t ]; then
  DB_USER=supabase_admin
fi
psql_db() { docker exec -i -e PGPASSWORD "$DB_CONTAINER" psql -X -q -h 127.0.0.1 -U "$DB_USER" "$@"; }

systemctl stop "$MYNT_SERVICE" || true
others=$(cd "$SUPABASE_DIR" && docker compose config --services | grep -vx "$DB_SERVICE" || true)
# shellcheck disable=SC2086
(cd "$SUPABASE_DIR" && docker compose stop $others)

# Every database but the templates goes first (FORCE also closes Postgres's own background connections); the dump
# then recreates each one with its settings and contents.
dbs=$(psql_db -d template1 -A -t -c "SELECT datname FROM pg_database WHERE NOT datistemplate")
for d in $dbs; do
  psql_db -d template1 -v ON_ERROR_STOP=1 -v d="$d" <<'SQL'
SELECT format('DROP DATABASE %I WITH (FORCE)', :'d') \gexec
SQL
done
psql_db -d template1 -v ON_ERROR_STOP=1 -c "CREATE DATABASE $SCRATCH"
# The role in use can't be dropped and recreated, so it reports errors and is then updated in place.
gunzip -c "$WORK/db.sql.gz" | psql_db -d "$SCRATCH" >/dev/null 2>"$WORK/errors" || true
psql_db -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH"
unset PGPASSWORD

if [ -f "$WORK/storage.tar.gz" ]; then
  aside="$STORAGE_DIR.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  [ ! -e "$STORAGE_DIR" ] || mv -T "$STORAGE_DIR" "$aside"
  tar --numeric-owner -C "$(dirname "$STORAGE_DIR")" -xzf "$WORK/storage.tar.gz"
  echo "Storage restored; the previous files are kept in $aside until you delete them."
fi

(cd "$SUPABASE_DIR" && docker compose up -d --quiet-pull)
systemctl start "$MYNT_SERVICE" || true

echo "Restore finished with $(grep -c 'ERROR' "$WORK/errors" || true) statement error(s) (expected: the role in use can't be dropped or created, and databases the dump drops were already gone):"
grep 'ERROR' "$WORK/errors" | sort | uniq -c | sort -rn | head -20 || true
PGPASSWORD=$(grep '^POSTGRES_PASSWORD=' "$SUPABASE_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
export PGPASSWORD
count_tables "$DB_CONTAINER" -h 127.0.0.1 -U "$DB_USER" -d postgres
