#!/usr/bin/env bash
# Sets up the EC2 instance that hosts Mynt's keyhouse enclave (the "parent"), from a checkout of the release's commit.
# Run once as root by the instance's first boot (keyhouse.cloudformation.json's user data), or by hand on an Amazon
# Linux 2023 instance with Nitro Enclaves enabled:
#
#   deploy/confidential/aws/parent-setup.sh --region <region> --kms-key <wrap key ARN> --client-ca-b64 <base64 PEM> \
#     --allowed-pcr0 <pcr0>[,<pcr0>…]
#
# What it does, and nothing else:
#   1. installs nitro-cli (the release's pinned version), docker and socat from Amazon Linux's own repositories;
#   2. sets the enclave allocator to 2 vCPUs and 3 GiB, the enclave's whole share of the instance;
#   3. builds the enclave image file from this checkout (build-eif.sh) and refuses to go on unless its PCR0 is one the
#      key policy allows: the same commit gives the same PCRs CI printed;
#   4. writes the service's settings (region, wrap key ARN, the one authority for Mynt's client certificate; none
#      secret) and prints the authority's SHA-256. The enclave binds all three into every attestation, and Mynt's
#      server and partners refuse an enclave whose settings aren't the ones they expect, so changing this file on
#      the instance (to another key, or to an authority of one's own) doesn't go unnoticed: it stops the service;
#   5. installs systemd units for the enclave and the five relays it needs, and starts them:
#        TCP 8443 (from Mynt's server only: the security group) -> enclave vsock 8443   inbound mutual TLS, end to end
#        vsock 8000 -> kms.<region>.amazonaws.com:443 (AWS's vsock-proxy)              KMS, TLS end to end
#        vsock 8001 -> the instance metadata service                                   the role's temporary credentials
#        vsock 8002 <- /etc/mynt-keyhouse/settings.json                                 the settings, read-only
#        vsock 8003 -> this journal                                                     the service's log lines
#
# The parent never sees a key: the enclave's TLS ends inside it, KMS answers only to an attested enclave, and the
# role's credentials alone can't use the wrap key (its key policy denies any call without a matching attestation).
set -euo pipefail
export HOME="${HOME:-/root}" # first boot runs without one; docker keeps its builder settings there

REGION="" KMS_KEY="" CLIENT_CA_B64="" ALLOWED_PCR0=""
while [ $# -gt 0 ]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --kms-key) KMS_KEY="$2"; shift 2 ;;
    --client-ca-b64) CLIENT_CA_B64="$2"; shift 2 ;;
    --allowed-pcr0) ALLOWED_PCR0="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$REGION" ] && [ -n "$KMS_KEY" ] && [ -n "$CLIENT_CA_B64" ] && [ -n "$ALLOWED_PCR0" ] || { echo "usage: see the top of $0" >&2; exit 2; }

HERE="$(cd "$(dirname "$0")" && pwd)"
STATE=/opt/mynt-keyhouse
ENCLAVE_CID=16
ENCLAVE_CPUS=2
ENCLAVE_MIB=3072
NITRO_CLI_VERSION=1.5.3

dnf install -y -q "aws-nitro-enclaves-cli-$NITRO_CLI_VERSION" "aws-nitro-enclaves-cli-devel-$NITRO_CLI_VERSION" docker socat python3
mkdir -p /etc/nitro_enclaves
# The allocator's own configuration format (nitro-cli reads it).
printf -- '---\nmemory_mib: %s\ncpu_count: %s\n' "$ENCLAVE_MIB" "$ENCLAVE_CPUS" >/etc/nitro_enclaves/allocator.yaml
systemctl enable --now docker nitro-enclaves-allocator.service

mkdir -p "$STATE"
"$HERE/build-eif.sh" "$STATE/eif" mynt-keyhouse-nitro:release
PCR0="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["pcr0"])' "$STATE/eif/pcrs.json")"
case ",$ALLOWED_PCR0," in
  *",$PCR0,"*) echo "Built the enclave image with PCR0 $PCR0, which the key policy allows." ;;
  *) echo "The enclave image built here has PCR0 $PCR0, which isn't one the key policy allows ($ALLOWED_PCR0): is this the release's commit?" >&2; exit 1 ;;
esac

install -d -m 0755 /etc/mynt-keyhouse
python3 -I - "$REGION" "$KMS_KEY" "$CLIENT_CA_B64" >/etc/mynt-keyhouse/settings.json <<'PY'
import base64, json, sys
region, kms_key, ca_b64 = sys.argv[1:4]
ca = base64.b64decode(ca_b64).decode()
# Exactly one certificate: the enclave refuses a bundle, since a second authority could call it as Mynt's server.
if ca.count("-----BEGIN CERTIFICATE-----") != 1 or ca.count("-----BEGIN ") != 1:
    sys.exit("the client authority must be exactly one base64 PEM certificate")
print(json.dumps({"region": region, "kms_key": kms_key, "client_ca": ca}))
PY
chmod 0644 /etc/mynt-keyhouse/settings.json
CLIENT_CA_SHA256="$(python3 -I -c 'import base64,hashlib,json,re,sys; pem=json.load(open(sys.argv[1]))["client_ca"]; print(hashlib.sha256(base64.b64decode(re.sub(r"-----[A-Z ]+-----|\s", "", pem))).hexdigest())' /etc/mynt-keyhouse/settings.json)"
echo "The enclave will accept client certificates from one authority, SHA-256 $CLIENT_CA_SHA256 (make-client-cert.sh printed the same on Mynt's server)."

unit() { cat >"/etc/systemd/system/$1.service"; }
unit mynt-keyhouse-enclave <<EOF
[Unit]
Description=Mynt keyhouse enclave (restarted if it stops)
After=nitro-enclaves-allocator.service
Requires=nitro-enclaves-allocator.service
[Service]
ExecStartPre=-/usr/bin/nitro-cli terminate-enclave --all
ExecStart=/bin/sh -c 'nitro-cli run-enclave --eif-path $STATE/eif/keyhouse.eif --cpu-count $ENCLAVE_CPUS --memory $ENCLAVE_MIB --enclave-cid $ENCLAVE_CID >/dev/null && while nitro-cli describe-enclaves | grep -q RUNNING; do sleep 30; done'
ExecStop=/usr/bin/nitro-cli terminate-enclave --all
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
EOF
unit mynt-keyhouse-inbound <<EOF
[Unit]
Description=Mynt keyhouse: Mynt's server (TCP 8443) to the enclave
[Service]
ExecStart=/usr/bin/socat TCP-LISTEN:8443,fork,reuseaddr VSOCK-CONNECT:$ENCLAVE_CID:8443
Restart=always
DynamicUser=yes
[Install]
WantedBy=multi-user.target
EOF
unit mynt-keyhouse-kms <<EOF
[Unit]
Description=Mynt keyhouse: the enclave to KMS in $REGION
[Service]
ExecStart=/usr/bin/vsock-proxy 8000 kms.$REGION.amazonaws.com 443
Restart=always
[Install]
WantedBy=multi-user.target
EOF
unit mynt-keyhouse-imds <<EOF
[Unit]
Description=Mynt keyhouse: the enclave to the instance metadata service (the role's credentials)
[Service]
ExecStart=/usr/bin/socat VSOCK-LISTEN:8001,fork,reuseaddr TCP:169.254.169.254:80
Restart=always
[Install]
WantedBy=multi-user.target
EOF
unit mynt-keyhouse-settings <<EOF
[Unit]
Description=Mynt keyhouse: the enclave's settings
[Service]
ExecStart=/usr/bin/socat -U VSOCK-LISTEN:8002,fork,reuseaddr OPEN:/etc/mynt-keyhouse/settings.json,rdonly
Restart=always
DynamicUser=yes
[Install]
WantedBy=multi-user.target
EOF
unit mynt-keyhouse-logs <<EOF
[Unit]
Description=Mynt keyhouse: the enclave's log lines
[Service]
ExecStart=/usr/bin/socat -u VSOCK-LISTEN:8003,fork,reuseaddr STDOUT
Restart=always
DynamicUser=yes
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now mynt-keyhouse-kms mynt-keyhouse-imds mynt-keyhouse-settings mynt-keyhouse-logs mynt-keyhouse-inbound
systemctl enable --now mynt-keyhouse-enclave
echo "The keyhouse enclave is running (PCR0 $PCR0). On Mynt's server: mynt confidential status."
