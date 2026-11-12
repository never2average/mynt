#!/usr/bin/env bash
# Prints Mynt's Caddy site for this host.
#   bash render-site.sh <domain> <app-port> [studio-upstream]
# Without a studio upstream it's site.caddy as it always was. With one (a host name such as the
# studio's deployment address), Mynt's own paths still go to Mynt and everything else goes to the
# studio (studio-routes.caddy). Domains and hosts are arguments only, never stored in the repo.
set -euo pipefail

DOMAIN=${1:?usage: render-site.sh <domain> <app-port> [studio-upstream]}
PORT=${2:?usage: render-site.sh <domain> <app-port> [studio-upstream]}
STUDIO=${3:-}
DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

host_name='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
[[ $DOMAIN =~ $host_name ]] || { echo "render-site.sh: '$DOMAIN' isn't a host name" >&2; exit 2; }
[[ $PORT =~ ^[0-9]{1,5}$ ]] || { echo "render-site.sh: '$PORT' isn't a port" >&2; exit 2; }

render() { sed -e "s|@DOMAIN@|$DOMAIN|g" -e "s|@PORT@|$PORT|g" -e "s|@STUDIO_UPSTREAM@|$STUDIO|g"; }

if [[ -z $STUDIO ]]; then
  render <"$DIR/site.caddy"
  exit 0
fi
[[ $STUDIO =~ $host_name ]] || { echo "render-site.sh: studio upstream '$STUDIO' isn't a host name (no scheme, port or path)" >&2; exit 2; }

# site.caddy up to its final catch-all (Mynt's own routes, unchanged), then the studio's routes,
# which close the site block.
marker=$'\t# Everything else (/, /llms.txt'
{
  found=0
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line == "$marker"* ]]; then found=1; break; fi
    printf '%s\n' "$line"
  done <"$DIR/site.caddy"
  [[ $found == 1 ]] || { echo "render-site.sh: site.caddy's catch-all wasn't found" >&2; exit 3; }
  cat "$DIR/studio-routes.caddy"
} | render
