import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { effectiveRoles, type Store, type User } from "./store.js";
import { SCHEMA, type ProductHealthService } from "./product-health.js";

// Tools for each product's financial health. Numbers go only to the product's licence provider and liquidity
// providers, admins included: an admin sees status and fingerprints (list_product_health) and reads numbers only as
// a member of an entitled firm, so a Mynt admin account can't quietly open a product's books.

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });
const attempt = async (f: () => Promise<unknown>) => {
  try {
    return json(await f());
  } catch (e) {
    return fail((e as Error).message);
  }
};

const product = z.string().min(1).describe("A product id");
const pool = z.string().min(1).optional().describe("A pool of the product, when pools exist");

export function registerProductHealthTools(server: McpServer, _store: Store, user: User, health: ProductHealthService) {
  server.registerTool(
    "list_product_health",
    {
      title: "Product health: fingerprints and status",
      description:
        "Every snapshot of a product's financial health that you may see: its sequence, period, fingerprint (the sha256 that goes on chain), status (pending_signature, ready, published, missed), source (sandbox, partner_ledger, unavailable), attestation and whether it's verified, plus any gaps a monitor should know about. Status only: the numbers come from get_product_health, and only for the product's licence provider and liquidity providers. Licence providers, the product's own firm, and admins.",
      inputSchema: { product_id: product.optional(), limit: z.number().int().min(1).max(200).default(24) },
      annotations: { readOnlyHint: true },
    },
    async ({ product_id, limit }) => attempt(() => health.listFor(user, product_id, limit)),
  );

  const roles = effectiveRoles(user.roles);
  if (!roles.includes("license_provider")) return;

  server.registerTool(
    "get_product_health",
    {
      title: "Product health: the numbers",
      description:
        "Licence provider (or a product's liquidity provider): the decrypted financial-health report of a product you're entitled to: reserves, customer obligations, coverage, flows, pending settlements, reversal and failure rates, in integer cents and basis points. A figure Mynt can't measure is null with its reason, never 0. With each snapshot, whether its report still matches its fingerprint and whether the fingerprint matches what's on chain, and the gaps in the record. Admins go through the same entitlement.",
      inputSchema: { product_id: product, pool_id: pool, limit: z.number().int().min(1).max(200).default(24) },
      annotations: { readOnlyHint: true },
    },
    async ({ product_id, pool_id, limit }) => attempt(() => health.get(user, product_id, pool_id ?? null, limit)),
  );

  server.registerTool(
    "register_partner_signing_key",
    {
      title: "Register your firm's snapshot signing key",
      description:
        "Licence provider: register your firm's Ed25519 public key (base58) for co-signing product-health snapshots. Your firm signs the fingerprint of each snapshot with its private key (which never reaches Mynt) and sends it with submit_partner_signature. Registering again replaces the key.",
      inputSchema: { public_key: z.string().min(32).max(64).describe("Your firm's Ed25519 public key, base58") },
    },
    async ({ public_key }) => attempt(() => health.registerSigningKey(user, public_key)),
  );

  server.registerTool(
    "submit_partner_signature",
    {
      title: "Co-sign a product-health snapshot",
      description: `Licence provider: co-sign a snapshot waiting for a signature (status pending_signature in list_product_health, within its window). Sign the 32 bytes of its fingerprint with Ed25519. A live product's snapshot counts as verified only when co-signed; one with no signature by the deadline is published as mynt_only, and says so. Schema: ${SCHEMA}.`,
      inputSchema: {
        product_id: product,
        pool_id: pool,
        sequence: z.number().int().min(1),
        signature: z.string().describe("The Ed25519 signature, hex or base58"),
      },
    },
    async ({ product_id, pool_id, sequence, signature }) => attempt(() => health.submitSignature(user, product_id, pool_id ?? null, sequence, signature)),
  );
}
