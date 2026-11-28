#!/usr/bin/env bash
# Starts your local validator from a clean ledger with the program at its real address, the way Mynt's own re-run
# does, and returns once it answers. It runs detached, so it never holds your turn open; an earlier one this script
# started is stopped first.
#   bash scripts/start_validator.sh         start (or restart from a clean ledger)
#   bash scripts/start_validator.sh stop    stop it
# Exit 0: the validator is up at the URL printed, with the program loaded. Exit 1: it didn't start; its log's end is
# printed. MYNT_VALIDATOR_RPC_PORT changes the port (default 8899, which is what Mynt's re-run uses).
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
eval "$(python3 - "$HERE/job/target.json" <<'PY'
import json, os, shlex, sys
t = json.load(open(sys.argv[1]))
print(f"PROGRAM={shlex.quote(str(t['program_id']))}")
print(f"SO={shlex.quote(str(t.get('program_so') or 'job/program.so'))}")
print(f"ENV_FILE={shlex.quote(os.path.expanduser(str(t.get('toolchain_env') or '~/.mynt-solana/env')))}")
PY
)"
DIR="$HERE/job/validator"
PORT="${MYNT_VALIDATOR_RPC_PORT:-8899}"
URL="http://127.0.0.1:$PORT"
mkdir -p "$DIR"

stop() {
  local pid
  pid="$(cat "$DIR/pid" 2>/dev/null || true)"
  # Only a process this script started: its command line names this ledger.
  if [ -n "$pid" ] && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF "$DIR/ledger"; then
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do [ -d "/proc/$pid" ] || break; sleep 0.5; done
  fi
  rm -f "$DIR/pid"
}
stop
[ "${1:-start}" = stop ] && { echo "stopped"; exit 0; }

[ -f "$ENV_FILE" ] || { echo "The toolchain isn't installed yet: run 'bash scripts/wait_toolchain.sh' first."; exit 1; }
. "$ENV_FILE"
cd "$HERE"
[ -f "$SO" ] || { echo "No program at $SO"; exit 1; }
rm -rf "$DIR/ledger"
[ -f "$DIR/authority.json" ] || solana-keygen new --no-bip39-passphrase --silent --force --outfile "$DIR/authority.json" >/dev/null
AUTHORITY="$(solana-keygen pubkey "$DIR/authority.json")"
setsid nohup solana-test-validator --reset --quiet --ledger "$DIR/ledger" --rpc-port "$PORT" \
  --upgradeable-program "$PROGRAM" "$SO" "$AUTHORITY" > "$DIR/validator.log" 2>&1 < /dev/null &
echo $! > "$DIR/pid"

for _ in $(seq 1 120); do
  if python3 - "$URL" "$PROGRAM" <<'PY' 2>/dev/null
import json, sys, urllib.request
def rpc(method, params):
    req = urllib.request.Request(sys.argv[1], json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r).get("result")
ok = rpc("getHealth", []) == "ok" and (rpc("getAccountInfo", [sys.argv[2], {"encoding": "base64"}]) or {}).get("value")
sys.exit(0 if ok else 1)
PY
  then
    echo "ready: $URL has $PROGRAM loaded (log: job/validator/validator.log; fund keys with 'solana airdrop <SOL> <pubkey> -u $URL')"
    exit 0
  fi
  [ -d "/proc/$(cat "$DIR/pid")" ] || break
  sleep 1
done
echo "FAILED: the validator didn't come up at $URL. The end of its log:"
tail -n 20 "$DIR/validator.log" 2>/dev/null
stop
exit 1
