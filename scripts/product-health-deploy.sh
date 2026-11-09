#!/usr/bin/env bash
# Deploys Mynt's product-health program to DEVNET. Operator-run only; CI never runs this and it can't reach mainnet.
#
#   scripts/product-health-deploy.sh --program-keypair <new-program-keypair.json> --authority <upgrade-authority-keypair.json>
#
# Run it from a checkout of this repository, with the server's environment loaded (DATABASE_URL and MYNT_VAULT_KEY,
# which it needs for the publisher key and which it never prints). It needs the pinned Solana toolchain (the same
# script CI and the build sandboxes use) and Docker for the verifiable build.
#
# It builds the program with the keypair's address written into a temporary copy, deploys it, creates the publisher
# key in Mynt's vault (it isn't the deploy authority), and names that publisher on chain. Then the operator sets
# PRODUCT_HEALTH_PROGRAM_ID on the server themselves and restarts it. Both keypair files stay where you keep them.
set -euo pipefail

PROGRAM_KEYPAIR="" AUTHORITY=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --program-keypair) PROGRAM_KEYPAIR="$2"; shift 2 ;;
    --authority) AUTHORITY="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$PROGRAM_KEYPAIR" ] && [ -n "$AUTHORITY" ] || { echo "Usage: $0 --program-keypair <path> --authority <path>" >&2; exit 2; }
[ -n "${DATABASE_URL:-}" ] && [ -n "${MYNT_VAULT_KEY:-}" ] || { echo "Load the server's environment first: DATABASE_URL and MYNT_VAULT_KEY are needed" >&2; exit 2; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLACEHOLDER="GLi9SM8q1Q8S1k5SFHWpZ7v9uWK9M5ZDxhd6ESjuSfVz"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$REPO"
npm run --silent build
mkdir -p "$WORK/mynt"
node -e 'import("./dist/solana/toolchain.js").then((m) => { const fs = require("fs"); fs.writeFileSync(process.argv[1] + "/solana-toolchain.sh", m.SOLANA_TOOLCHAIN_SCRIPT); fs.writeFileSync(process.argv[1] + "/solana-verify.sh", m.SOLANA_VERIFY_SCRIPT) })' "$WORK/mynt"
bash "$WORK/mynt/solana-toolchain.sh"
. "${MYNT_SOLANA_HOME:-$HOME/.mynt-solana}/env"

ADDRESS="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
AUTHORITY_ADDRESS="$(solana-keygen pubkey "$AUTHORITY")"
echo "Program address: $ADDRESS (upgrade authority: $AUTHORITY_ADDRESS)"

mkdir -p "$WORK/app"
cp -r programs/product-health "$WORK/app/solana"
sed -i "s/$PLACEHOLDER/$ADDRESS/g" "$WORK/app/solana/programs/product_health/src/lib.rs" "$WORK/app/solana/Anchor.toml"
bash "$WORK/mynt/solana-verify.sh" build "$WORK/app" "$WORK/out" "$REPO/schemas/solana-crate-allowlist.json"
grep -q '"name": "solana_build", "status": "pass"' "$WORK/out/checks.jsonl" || { cat "$WORK/out/checks.jsonl"; exit 1; }

node "$REPO/scripts/program-rules.mjs" --sources "$WORK/out/solana.sources.json" --program-id "$ADDRESS" \
  --so "$WORK/out/product_health.so" --idl "$WORK/out/product_health.build-idl.json" --deps "$WORK/out/solana.deps.json" --depinfo "$WORK/out/solana.depinfo.json" >/dev/null \
  || { echo "The program didn't pass Mynt's mainnet gate rules"; exit 1; }

sha256sum "$WORK/out/product_health.so"
solana program deploy --url devnet --keypair "$AUTHORITY" --program-id "$PROGRAM_KEYPAIR" --upgrade-authority "$AUTHORITY" "$WORK/out/product_health.so"

PUBLISHER="$(node dist/index.js product-health publisher --program-id "$ADDRESS")"
echo "Publisher (in the vault; pays its own fees): $PUBLISHER"
node dist/index.js product-health init --program-id "$ADDRESS" --file "$AUTHORITY"

echo
echo "Done. Now set this on the server yourself, then restart Mynt:"
echo "  PRODUCT_HEALTH_PROGRAM_ID=$ADDRESS"
