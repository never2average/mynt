#!/usr/bin/env bash
# The hosting gateway, on the host that runs Mynt: WireGuard for developers' tenant VMs, an egress proxy that
# only reaches allowed hosts, and edge routes for hosted apps. Tenants reach nothing directly: forwarding
# from the tunnel is dropped, and only the proxy (CONNECT to allowlisted hosts) leaves the box.
#   bash hosting-gateway.sh            set up once, then a timer re-syncs every minute
# Quiet: logs to /var/log/mynt/gateway.log. Prints the gateway's WireGuard public key for Mynt's env
# (HOSTING_GATEWAY_PUBLIC_KEY) to /etc/mynt/gateway/wg.pub.
set -euo pipefail
LOG=/var/log/mynt/gateway.log
mkdir -p /var/log/mynt
exec >>"$LOG" 2>&1
echo "=== $(date -Is) sync"

DIR=/etc/mynt/gateway
COMPANION=/etc/caddy-companion
TUNNEL=10.88.0.1
PORT=51820
PROXY_PORT=8888

if ! command -v wg >/dev/null || ! command -v tinyproxy >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q && apt-get install -yq wireguard-tools tinyproxy
fi
umask 077
mkdir -p "$DIR"
[ -s "$DIR/wg.key" ] || wg genkey >"$DIR/wg.key"
wg pubkey <"$DIR/wg.key" >"$DIR/wg.pub"
chmod 644 "$DIR/wg.pub"

# Mynt's view of the tenants, read as the mynt user with its environment (never on a command line).
# The server is the release's core/ folder; releases from before the monorepo had it at the root.
MYNT_JS=/opt/mynt/current/core/dist/index.js
[ -f "$MYNT_JS" ] || MYNT_JS=/opt/mynt/current/dist/index.js
mynt() { runuser -u mynt -- bash -c 'set -a; . /etc/mynt/env; set +a; exec node "$1" hosting "$0"' "$1" "$MYNT_JS"; }

# WireGuard: running tenants only; anything else they send is dropped except the proxy.
{
  echo "[Interface]"
  echo "Address = $TUNNEL/16"
  echo "ListenPort = $PORT"
  echo "PrivateKey = $(cat "$DIR/wg.key")"
  echo "PostUp = iptables -I FORWARD -i %i -j DROP; iptables -I INPUT -i %i -p tcp --dport $PROXY_PORT -j ACCEPT; iptables -A INPUT -i %i -j DROP"
  echo "PostDown = iptables -D FORWARD -i %i -j DROP; iptables -D INPUT -i %i -p tcp --dport $PROXY_PORT -j ACCEPT; iptables -D INPUT -i %i -j DROP"
  echo
  mynt wg-peers
} >"$DIR/wg-mynt.conf.new"
install -m 600 "$DIR/wg-mynt.conf.new" /etc/wireguard/wg-mynt.conf
rm -f "$DIR/wg-mynt.conf.new"
if systemctl is-active --quiet wg-quick@wg-mynt; then
  wg syncconf wg-mynt <(wg-quick strip wg-mynt)
else
  systemctl enable --now wg-quick@wg-mynt
fi

# Egress: CONNECT only to allowlisted hosts, only from the tunnel.
mynt egress-allowlist | sed 's/\./\\./g; s/^/^/; s/$/$/' >"$DIR/egress.filter"
cat >/etc/tinyproxy/tinyproxy.conf <<CONF
User tinyproxy
Group tinyproxy
Port $PROXY_PORT
Listen $TUNNEL
Allow 10.88.0.0/16
ConnectPort 443
Filter "$DIR/egress.filter"
FilterDefaultDeny Yes
FilterExtended Yes
FilterURLs Off
LogLevel Warning
CONF
chmod 644 "$DIR/egress.filter"
systemctl restart tinyproxy

# Edge: <app>.<apps domain> to each hosted app on its tenant's tunnel address.
mynt routes >"$COMPANION/sites/mynt-hosted.caddy.new"
chmod 644 "$COMPANION/sites/mynt-hosted.caddy.new"
if ! cmp -s "$COMPANION/sites/mynt-hosted.caddy.new" "$COMPANION/sites/mynt-hosted.caddy"; then
  mv "$COMPANION/sites/mynt-hosted.caddy.new" "$COMPANION/sites/mynt-hosted.caddy"
  caddy validate --config "$COMPANION/Caddyfile" --adapter caddyfile && systemctl reload caddy
else
  rm -f "$COMPANION/sites/mynt-hosted.caddy.new"
fi

# Re-sync every minute.
if [ ! -f /etc/systemd/system/mynt-gateway.timer ]; then
  cp "$(readlink -f "$0")" /usr/local/sbin/mynt-gateway-sync
  chmod 700 /usr/local/sbin/mynt-gateway-sync
  printf '[Service]\nType=oneshot\nExecStart=/usr/local/sbin/mynt-gateway-sync\n' >/etc/systemd/system/mynt-gateway.service
  printf '[Timer]\nOnBootSec=30\nOnUnitActiveSec=60\n[Install]\nWantedBy=timers.target\n' >/etc/systemd/system/mynt-gateway.timer
  systemctl daemon-reload && systemctl enable --now mynt-gateway.timer
fi
echo "=== $(date -Is) done"
