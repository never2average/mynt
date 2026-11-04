#!/usr/bin/env bash
# Backs up Mynt's self-hosted Supabase: every database and role (pg_dumpall) and the Storage files.
#   bash backup.sh            back up now (the daily timer)
#   bash backup.sh --verify   test-restore the newest local backup into a throwaway container (the weekly timer)
# Quiet: logs to /var/log/mynt/backup.log and prints one line only when something fails. Never prints secrets.
#
# Settings come from the environment or from KEY=value lines in the root-only file /etc/mynt/backup.env (mode 0600;
# the environment wins):
#   SUPABASE_DIR             Supabase's Docker Compose directory              (default /opt/supabase)
#   BACKUP_DB_CONTAINER      its Postgres container                           (default supabase-db)
#   BACKUP_DB_USER           the superuser that dumps                         (default postgres, else supabase_admin)
#   BACKUP_STORAGE_DIR       Storage's files                                  (default $SUPABASE_DIR/volumes/storage)
#   BACKUP_DIR               local copies, kept BACKUP_KEEP_LOCAL_DAYS days   (default /var/backups/mynt, 7)
#   MYNT_BACKUP_STATUS_FILE  the status Mynt's ops_status reads               (default /var/lib/mynt/backup-status.json)
#   BACKUP_AGE_RECIPIENT     age public key(s), space-separated; off-site copies are encrypted to them
#   BACKUP_REMOTE            rclone destination for off-site copies, e.g. myntbackup:bucket/mynt; the remote itself
#                            is configured only by RCLONE_CONFIG_<NAME>_* variables in the same file
#   BACKUP_KEEP_DAILY, BACKUP_KEEP_WEEKLY   off-site retention (default 14 daily, 8 weekly from Sundays)
# Nothing leaves the server unencrypted: without a recipient, backups stay local and the status says so.
set -eEuo pipefail
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
STORAGE_DIR=${BACKUP_STORAGE_DIR:-$SUPABASE_DIR/volumes/storage}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/mynt}
STATUS_FILE=${MYNT_BACKUP_STATUS_FILE:-/var/lib/mynt/backup-status.json}
KEEP_LOCAL_DAYS=${BACKUP_KEEP_LOCAL_DAYS:-7}
KEEP_DAILY=${BACKUP_KEEP_DAILY:-14}
KEEP_WEEKLY=${BACKUP_KEEP_WEEKLY:-8}
RECIPIENT=${BACKUP_AGE_RECIPIENT:-}
REMOTE=${BACKUP_REMOTE:-}
LOG=${BACKUP_LOG:-/var/log/mynt/backup.log}
HERE=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
MODE=backup
case "${1:-}" in
  "") ;;
  --verify) MODE=verify ;;
  *) echo "usage: backup.sh [--verify]" >&2; exit 2 ;;
esac

install -d -m 700 "$(dirname "$LOG")" "$BACKUP_DIR"
install -d -m 755 "$(dirname "$STATUS_FILE")"
exec 3>&2 >>"$LOG" 2>&1
echo "=== $(date -Is) $MODE"
exec 9>"$BACKUP_DIR/.lock"
flock -w 3600 9

# The status file: a small JSON that ops_status reads. Merged, so a backup keeps the last restore test and back.
status() {
  STATUS_FILE="$STATUS_FILE" node - "$@" <<'JS'
const fs = require("fs");
const file = process.env.STATUS_FILE;
let s = {};
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
const [mode, ok, a, b, c, d] = process.argv.slice(2);
const now = new Date().toISOString();
const good = ok === "true";
if (mode === "backup") {
  Object.assign(s, { at: now, ok: good, local: a || null, offsite: b || null, bytes: c ? Number(c) : null, error: d || null });
  if (good) s.last_success_at = now;
} else {
  const tables = {};
  for (const line of (b || "").split("\n")) { const m = line.match(/^table_count (\S+) (\d+)$/); if (m) tables[m[1]] = Number(m[2]); }
  const files = (b || "").match(/^storage_files (\d+)$/m);
  s.verify = { at: now, ok: good, backup: a || null, tables, storage_files: files ? Number(files[1]) : null, error: c || null };
}
fs.writeFileSync(file + ".tmp", JSON.stringify(s, null, 2) + "\n", { mode: 0o644 });
fs.renameSync(file + ".tmp", file);
JS
  chmod 644 "$STATUS_FILE"
}

STEP="starting"
fail() {
  local code=$?
  trap - ERR
  # errtrace runs this in subshells too; only the script itself reports.
  [ "$BASHPID" = "$$" ] || exit "$code"
  if [ "$MODE" = backup ]; then
    status backup false "" "${OFFSITE:-failed}" "" "failed while $STEP (details in the backup log)" || true
    rm -rf "${PARTIAL:-}" "${SEALED:-}"
  else
    status verify false "${NEWEST:-}" "" "failed while $STEP (details in the backup log)" || true
  fi
  echo "mynt $MODE failed while $STEP; details in $LOG" >&3
  exit "$code"
}
trap fail ERR

human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "$1 bytes"; }

# --- weekly restore test ---------------------------------------------------------------------------
if [ "$MODE" = verify ]; then
  STEP="finding the newest backup"
  NEWEST=$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*Z' -printf '%f\n' | LC_ALL=C sort | tail -n 1)
  [ -n "$NEWEST" ]
  STEP="test-restoring $NEWEST"
  OUT=$(bash "$HERE/restore.sh" --test "$BACKUP_DIR/$NEWEST")
  echo "$OUT"
  status verify true "$NEWEST" "$OUT"
  echo "=== $(date -Is) verified $NEWEST"
  exit 0
fi

# --- dump ----------------------------------------------------------------------------------------
STAMP=$(date -u +%Y-%m-%dT%H%M%SZ)
PARTIAL="$BACKUP_DIR/.$STAMP.partial"
install -d -m 700 "$PARTIAL"
OFFSITE=failed

STEP="dumping the database"
# --clean makes the dump replayable over an existing cluster: it recreates each database, so restore.sh can
# bring back database-level settings too.
# Supabase's Postgres password is read from its own .env and handed to docker by name, never on a command line.
if [ -r "$SUPABASE_DIR/.env" ] && grep -q '^POSTGRES_PASSWORD=' "$SUPABASE_DIR/.env"; then
  PGPASSWORD=$(grep '^POSTGRES_PASSWORD=' "$SUPABASE_DIR/.env" | cut -d= -f2-)
  export PGPASSWORD
fi
# A full dump and restore need a superuser; some Supabase images make "postgres" an ordinary role, and then the
# image's own superuser, supabase_admin, is used (same password).
if [ "$(docker exec -e PGPASSWORD "$DB_CONTAINER" psql -X -A -t -h 127.0.0.1 -U "$DB_USER" -d postgres -c 'SELECT rolsuper FROM pg_roles WHERE rolname = current_user' 2>/dev/null)" != t ]; then
  DB_USER=supabase_admin
fi
docker exec -e PGPASSWORD "$DB_CONTAINER" pg_dumpall --clean --if-exists -h 127.0.0.1 -U "$DB_USER" | gzip -6 >"$PARTIAL/db.sql.gz"
unset PGPASSWORD
gzip -t "$PARTIAL/db.sql.gz"
# A dump that ended early has no completion line.
gunzip -c "$PARTIAL/db.sql.gz" | tail -n 5 | grep -q 'PostgreSQL database cluster dump complete'

STEP="archiving Storage's files"
[ -d "$STORAGE_DIR" ]
# Exit 1 from tar means a file changed while it was read (Storage is live); anything else is a failure.
rc=0
tar --numeric-owner --warning=no-file-changed -C "$(dirname "$STORAGE_DIR")" -czf "$PARTIAL/storage.tar.gz" "$(basename "$STORAGE_DIR")" || rc=$?
[ "$rc" -le 1 ]
gzip -t "$PARTIAL/storage.tar.gz"

(cd "$PARTIAL" && sha256sum db.sql.gz storage.tar.gz >SHA256SUMS)
chmod 600 "$PARTIAL"/*
mv -T "$PARTIAL" "$BACKUP_DIR/$STAMP"
PARTIAL=""
DIR="$BACKUP_DIR/$STAMP"
BYTES=$(( $(stat -c %s "$DIR/db.sql.gz") + $(stat -c %s "$DIR/storage.tar.gz") ))

# --- local retention: BACKUP_KEEP_LOCAL_DAYS days, and never the newest -----------------------------
STEP="pruning old local backups"
CUTOFF=$(date -u -d "$KEEP_LOCAL_DAYS days ago" +%Y-%m-%dT%H%M%SZ)
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d \( -name '.*.partial' -o -name '.sealed.*' \) -mmin +360 -exec rm -rf {} +
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*Z' -printf '%f\n' | LC_ALL=C sort | while read -r d; do
  if [ "$d" != "$STAMP" ] && [[ "$d" < "$CUTOFF" ]]; then rm -rf "${BACKUP_DIR:?}/$d"; fi
done
KEPT=$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*Z' | wc -l)
LOCAL="$KEPT backup(s) on this server; newest $STAMP: database $(human "$(stat -c %s "$DIR/db.sql.gz")"), Storage $(human "$(stat -c %s "$DIR/storage.tar.gz")")"

# --- off-site: encrypted copies only --------------------------------------------------------------
if [ -z "$RECIPIENT" ] || [ -z "$REMOTE" ]; then
  OFFSITE=local_only
  if [ -n "$REMOTE" ]; then echo "off-site remote set but no BACKUP_AGE_RECIPIENT: refusing to upload unencrypted"; fi
  status backup true "$LOCAL" local_only "$BYTES"
  echo "=== $(date -Is) done $STAMP (local only)"
  exit 0
fi

STEP="encrypting the off-site copies"
SEALED=$(mktemp -d "$BACKUP_DIR/.sealed.XXXXXX")
args=()
for r in $RECIPIENT; do args+=(-r "$r"); done
for f in db.sql.gz storage.tar.gz SHA256SUMS; do
  age "${args[@]}" -o "$SEALED/$f.age" "$DIR/$f"
done

STEP="uploading off-site"
RCLONE=(rclone --config /dev/null -q --retries 3 --low-level-retries 10)
"${RCLONE[@]}" copy "$SEALED" "$REMOTE/daily/$STAMP"
STEP="checking the off-site copy"
for f in "$SEALED"/*.age; do
  want=$(stat -c %s "$f")
  got=$("${RCLONE[@]}" lsf --format s "$REMOTE/daily/$STAMP/$(basename "$f")")
  [ "$got" = "$want" ]
done
if [ "$(date -u +%u)" = 7 ]; then
  STEP="keeping Sunday's copy as a weekly"
  "${RCLONE[@]}" copy "$REMOTE/daily/$STAMP" "$REMOTE/weekly/$STAMP"
fi
rm -rf "$SEALED"
SEALED=""

STEP="applying off-site retention"
prune() { # <prefix> <keep>: newest <keep> stay, older ones go
  local list d
  list=$("${RCLONE[@]}" lsf --dirs-only "$REMOTE/$1" 2>/dev/null) || list="" # a prefix with nothing in it yet
  for d in $(printf '%s\n' "$list" | sed 's:/$::' | { grep -E '^20[0-9T-]+Z$' || true; } | LC_ALL=C sort -r | tail -n +"$(( $2 + 1 ))"); do
    "${RCLONE[@]}" purge "$REMOTE/$1/$d"
  done
}
prune daily "$KEEP_DAILY"
prune weekly "$KEEP_WEEKLY"

OFFSITE=uploaded
status backup true "$LOCAL" uploaded "$BYTES"
echo "=== $(date -Is) done $STAMP (uploaded)"
