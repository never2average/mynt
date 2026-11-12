#!/usr/bin/env bash
# The live preview while the agents code. Mynt runs this (the agents don't): it starts the app's api on port 3000
# and Vite's dev server for web/ on port 5173, with hot reload, from the working tree as it is, detached, and
# leaves them running. Mynt serves port 5173 to the developer at a private link.
#
# It installs nothing: it waits until the agents have installed the app (node_modules) and built the SDK, so it
# never races their npm. The api runs on the build's Mynt sandbox key (simulated hand-offs only).
#
# usage: bash scripts/dev_preview.sh [app dir]     prints one of: no-web, waiting, running, started
#        bash scripts/dev_preview.sh --stop [app dir]
set -u
STOP=0
if [ "${1:-}" = "--stop" ]; then STOP=1; shift; fi
APP="$(cd "${1:-$HOME/workspace/app}" 2>/dev/null && pwd)" || { echo no-web; exit 0; }
STATE="$HOME/.mynt-dev-preview"
mkdir -p "$STATE"

alive() { [ -f "$STATE/$1.pid" ] && kill -0 "$(cat "$STATE/$1.pid")" 2>/dev/null; }
# Each part runs in its own process group (setsid), so stopping it takes everything it started.
end() { if alive "$1"; then kill -- "-$(cat "$STATE/$1.pid")" 2>/dev/null || kill "$(cat "$STATE/$1.pid")" 2>/dev/null; fi; rm -f "$STATE/$1.pid"; }

if [ "$STOP" = 1 ]; then
  end web
  end api
  echo stopped
  exit 0
fi

[ -f "$APP/web/package.json" ] || { echo no-web; exit 0; }
if alive web; then echo running; exit 0; fi
if [ ! -d "$APP/node_modules" ] && [ ! -d "$APP/web/node_modules" ]; then echo waiting; exit 0; fi
if [ -d "$APP/packages/mynt-sdk" ] && [ ! -d "$APP/packages/mynt-sdk/dist" ]; then echo waiting; exit 0; fi

export MYNT_API_KEY="${MYNT_API_KEY:-${MYNT_SANDBOX_KEY:-}}"
cd "$APP"

if [ -f "$APP/api/src/server.ts" ] && ! alive api; then
  PORT=3000 setsid bash -c 'echo $$ > "$0/api.pid"; exec npx --yes tsx@4.19.2 watch api/src/server.ts' "$STATE" >"$STATE/api.log" 2>&1 < /dev/null &
fi
# MYNT_LIVE_PREVIEW tells web/vite.config.ts it's behind the sandbox host's HTTPS forwarder.
MYNT_LIVE_PREVIEW=1 setsid bash -c 'echo $$ > "$0/web.pid"; cd web; exec npm run dev -- --host 0.0.0.0 --port 5173 --strictPort' "$STATE" >"$STATE/web.log" 2>&1 < /dev/null &

# The pid files are written by the processes themselves; give them a moment.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if alive web; then echo started; exit 0; fi
  sleep 0.5
done
echo "the dev server didn't start; see $STATE/web.log" >&2
exit 1
