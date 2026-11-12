#!/usr/bin/env bash
# The live preview while the agents code. Mynt runs this (the agents don't): it starts the app's dev servers from
# the working tree as it is, detached, and leaves them running: Vite for web/ on 127.0.0.1:5173 (hot reload) and,
# when api/ has a `dev` script, the api on port 3000 (the template's runs `tsx watch` on the build's Mynt sandbox
# key: simulated hand-offs only). Mynt serves port 5173 to the developer at a private link, and stops both with
# --stop before it packages the source.
#
# It runs only what the agents installed, and never runs npm install itself: it waits until their install has
# finished (no npm install running, and npm's lockfile written), so it never races their npm.
#
# usage: bash scripts/dev_preview.sh [app dir]     prints one of: no-web, waiting, running, started
#        bash scripts/dev_preview.sh --stop [app dir]
# `started` and `running` mean the dev server answers on 5173; anything else means "try again later".
set -u
STOP=0
if [ "${1:-}" = "--stop" ]; then STOP=1; shift; fi
STATE="$HOME/.mynt-dev-preview"
mkdir -p "$STATE"
PORT_WEB=5173

alive() { [ -f "$STATE/$1.pid" ] && kill -0 "$(cat "$STATE/$1.pid")" 2>/dev/null; }
# Each part runs in its own process group (setsid), so stopping it takes everything it started.
end() { if alive "$1"; then kill -- "-$(cat "$STATE/$1.pid")" 2>/dev/null || kill "$(cat "$STATE/$1.pid")" 2>/dev/null; fi; rm -f "$STATE/$1.pid"; }
answers() { curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT_WEB/" 2>/dev/null; }
# Up to $1 seconds for the dev server to answer.
wait_answer() { for _ in $(seq 1 "$(($1 * 2))"); do answers && return 0; alive web || return 1; sleep 0.5; done; return 1; }

if [ "$STOP" = 1 ]; then
  end web
  end api
  echo stopped
  exit 0
fi

APP="$(cd "${1:-$HOME/workspace/app}" 2>/dev/null && pwd)" || { echo no-web; exit 0; }
[ -f "$APP/web/package.json" ] || { echo no-web; exit 0; }
if alive web; then
  if wait_answer 5; then echo running; else echo waiting; fi
  exit 0
fi
# The agents' install has finished: npm's own lockfile in node_modules, and no npm install still running.
if [ ! -f "$APP/node_modules/.package-lock.json" ] && [ ! -f "$APP/web/node_modules/.package-lock.json" ]; then echo waiting; exit 0; fi
if pgrep -u "$(id -u)" -f 'npm(-cli\.js)? (install|i|ci|add)( |$)' >/dev/null 2>&1; then echo waiting; exit 0; fi
if [ -d "$APP/packages/mynt-sdk" ] && [ ! -d "$APP/packages/mynt-sdk/dist" ]; then echo waiting; exit 0; fi

export MYNT_API_KEY="${MYNT_API_KEY:-${MYNT_SANDBOX_KEY:-}}"
# Vite's cache stays outside the app, so it's never part of the source Mynt packages.
export MYNT_VITE_CACHE="$STATE/vite-cache"
cd "$APP"

if [ -f "$APP/api/package.json" ] && grep -q '"dev"' "$APP/api/package.json" && ! alive api; then
  PORT=3000 setsid bash -c 'echo $$ > "$0/api.pid"; cd api; exec npm run dev' "$STATE" >"$STATE/api.log" 2>&1 < /dev/null &
fi
# MYNT_LIVE_PREVIEW tells web/vite.config.ts it's behind the sandbox host's HTTPS forwarder.
MYNT_LIVE_PREVIEW=1 setsid bash -c 'echo $$ > "$0/web.pid"; cd web; exec npm run dev -- --host 127.0.0.1 --port '"$PORT_WEB"' --strictPort' "$STATE" >"$STATE/web.log" 2>&1 < /dev/null &

# The pid files are written by the processes themselves; then Vite has a little while to answer.
for _ in 1 2 3 4 5 6 7 8 9 10; do alive web && break; sleep 0.5; done
if wait_answer 20; then echo started; else echo waiting; fi
