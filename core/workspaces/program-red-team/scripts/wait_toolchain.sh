#!/usr/bin/env bash
# Waits, in the foreground, for the pinned Solana toolchain Mynt installs when the sandbox starts.
#   bash scripts/wait_toolchain.sh [seconds to wait in this call, default 100]
# Exit 0: installed; source the env file it names. Exit 1: the install failed; the end of its log is printed.
# Exit 2: still installing when this call's wait ran out; run it again.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WAIT="${1:-100}"
eval "$(python3 - "$HERE/job/target.json" <<'PY'
import json, os, shlex, sys
t = json.load(open(sys.argv[1]))
p = lambda k, d: shlex.quote(os.path.expanduser(str(t.get(k) or d)))
print(f"ENV_FILE={p('toolchain_env', '~/.mynt-solana/env')}")
print(f"LOG={p('toolchain_log', '~/.mynt-solana-install.log')}")
print(f"EXIT_FILE={p('toolchain_exit', '~/.mynt-solana-install.exit')}")
print(f"INSTALLER={p('toolchain_installer', '~/mynt-solana-toolchain.sh')}")
PY
)"
ROOT="$(dirname "$ENV_FILE")"
ready() { [ -f "$ENV_FILE" ] && ls "$ROOT"/ready-* >/dev/null 2>&1; }
END=$(( $(date +%s) + WAIT ))
while :; do
  if ready; then
    echo "ready: run '. $ENV_FILE' in each shell before using solana, solana-keygen or solana-test-validator"
    exit 0
  fi
  if [ -f "$EXIT_FILE" ] && [ "$(tr -d '[:space:]' < "$EXIT_FILE")" != 0 ]; then
    echo "FAILED: the toolchain's install exited $(tr -d '[:space:]' < "$EXIT_FILE"). The end of its log ($LOG):"
    tail -n 15 "$LOG" 2>/dev/null
    echo "Run it once more yourself in the foreground: bash $INSTALLER (it picks up where it stopped), then this script again."
    echo "If it fails again, finish with a report that has complete false and this log's last line as incomplete_reason."
    exit 1
  fi
  [ "$(date +%s)" -ge "$END" ] && break
  sleep 5
done
echo "still installing after ${WAIT}s (this is normal for the first few minutes). The log's last line:"
tail -n 1 "$LOG" 2>/dev/null
echo "Run this script again now, in the foreground. Don't end your turn to wait."
exit 2
