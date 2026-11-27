#!/usr/bin/env bash
# Makes Mynt's server's client certificate for the confidential service, on Mynt's server, once:
#
#   deploy/confidential/make-client-cert.sh <directory only Mynt's user can read, e.g. /etc/mynt/confidential>
#
# Writes client.crt and client.key there (CONFIDENTIAL_HOST_CLIENT_CERT and CONFIDENTIAL_HOST_CLIENT_KEY point at
# them), and an authority whose certificate the service trusts (ca.crt). The authority's private key is used once and
# deleted, so no other client certificate can ever be issued from it. Prints only the authority's certificate, base64:
# public, and what the service's settings need (ClientAuthorityBase64 in the CloudFormation template). Never a key.
#
# The service binds the SHA-256 of that authority's certificate into every attestation. Mynt's server computes the
# value it expects from ca.crt (CONFIDENTIAL_HOST_CLIENT_CA points at it) and refuses a service that trusts any other
# authority; partners check the same value (verify-mynt-enclave --expected-client-ca-sha256), which this prints for
# Mynt to publish. So keep ca.crt: without it the server can't say whose callers the service should accept.
set -euo pipefail
dir="${1:?usage: make-client-cert.sh <directory>}"
umask 077
mkdir -p "$dir"
[ ! -e "$dir/client.key" ] || { echo "$dir/client.key already exists: not replacing it" >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
ec=(-newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes)
openssl req -x509 "${ec[@]}" -keyout "$work/ca.key" -out "$dir/ca.crt" -days 3650 -subj "/CN=mynt-keyhouse-clients" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign" 2>/dev/null
openssl req "${ec[@]}" -keyout "$dir/client.key" -out "$work/client.csr" -subj "/CN=mynt-core" 2>/dev/null
printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n' >"$work/ext"
openssl x509 -req -in "$work/client.csr" -CA "$dir/ca.crt" -CAkey "$work/ca.key" -CAserial "$work/ca.srl" -CAcreateserial -out "$dir/client.crt" -days 3650 -extfile "$work/ext" 2>/dev/null
chmod 0600 "$dir/client.key"
chmod 0644 "$dir/client.crt" "$dir/ca.crt"
echo "Client certificate: $dir/client.crt (key: $dir/client.key, readable only by this user)." >&2
echo "The authority's certificate: $dir/ca.crt (set CONFIDENTIAL_HOST_CLIENT_CA to this path)." >&2
echo "Its SHA-256, which the service's attestation must bind (public; publish it for partners): $(openssl x509 -in "$dir/ca.crt" -outform DER | sha256sum | cut -d' ' -f1)" >&2
echo "The authority's certificate, base64 (public; paste it as ClientAuthorityBase64):" >&2
base64 -w0 "$dir/ca.crt"
echo
