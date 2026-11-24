#!/usr/bin/env bash
# Builds the keyhouse's enclave image file (EIF) from this checkout and prints its measurements: PCR0 (the whole image),
# PCR1 (kernel and boot ramdisk) and PCR2 (the application), as JSON. Reproducible: the same commit gives the same PCRs
# on any machine (CI builds it twice and compares, and the parent instance builds it again from the same commit), because
# every input is pinned: the base images by digest (Dockerfile), file timestamps to the commit's time, and the
# nitro-cli release whose kernel and boot ramdisk go into the EIF.
#
#   deploy/confidential/aws/build-eif.sh <output-dir> [image-tag]
#
# Uses nitro-cli when it's installed (the parent instance), or else runs it in a pinned Amazon Linux container (CI).
# Needs docker with buildx. Pushes nothing.
set -euo pipefail

out="${1:?usage: build-eif.sh <output-dir> [image-tag]}"
tag="${2:-mynt-keyhouse-nitro:local}"
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
AL2023="amazonlinux:2023@sha256:edd3297df7d444ab9a7896b763d5305d4bab57d2fb3943e831c1713b97d32d9d"
NITRO_CLI_VERSION="1.5.3"

export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$repo" log -1 --format=%ct)}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"

# A builder of its own with a pinned BuildKit, so the build is the same here, in CI and on the parent instance. Its
# output: an OCI archive with timestamps rewritten to the commit's, then loaded into the daemon for nitro-cli.
BUILDKIT="moby/buildkit:v0.25.2@sha256:0f63d66f8d2de0bd16438284831a3e9ee6ca7cd57b6eb3ed6e38a7a456590fa7"
docker buildx inspect mynt-eif >/dev/null 2>&1 || docker buildx create --name mynt-eif --driver docker-container --driver-opt "image=$BUILDKIT" >&2
docker buildx build --builder mynt-eif --no-cache --platform linux/amd64 --provenance=false --sbom=false --target nitro \
  --output "type=oci,name=$tag,dest=$out/keyhouse-image.tar,rewrite-timestamp=true" "$here" >&2
docker load --input "$out/keyhouse-image.tar" >&2
rm -f "$out/keyhouse-image.tar"

if command -v nitro-cli >/dev/null 2>&1; then
  installed="$(nitro-cli --version | awk '{print $NF}')"
  [ "$installed" = "$NITRO_CLI_VERSION" ] || { echo "nitro-cli $installed is installed; the release's PCRs need $NITRO_CLI_VERSION" >&2; exit 1; }
  nitro-cli build-enclave --docker-uri "$tag" --output-file "$out/keyhouse.eif" >"$out/build.out"
else
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$out:/eif" "$AL2023" sh -c \
    "dnf install -y -q aws-nitro-enclaves-cli-$NITRO_CLI_VERSION aws-nitro-enclaves-cli-devel-$NITRO_CLI_VERSION >/dev/null \
     && mkdir -p /var/log/nitro_enclaves \
     && nitro-cli build-enclave --docker-uri '$tag' --output-file /eif/keyhouse.eif" >"$out/build.out"
fi

sed -n '/^{/,$p' "$out/build.out" >"$out/measurements.json"
python3 -I -c '
import json, re, sys
m = json.load(open(sys.argv[1])).get("Measurements", {})
pcrs = {"pcr0": m.get("PCR0", ""), "pcr1": m.get("PCR1", ""), "pcr2": m.get("PCR2", "")}
if not all(re.fullmatch("[0-9a-f]{96}", p) for p in pcrs.values()):
    sys.exit("nitro-cli printed no PCRs")
print(json.dumps(pcrs, indent=2))
' "$out/measurements.json" | tee "$out/pcrs.json"
