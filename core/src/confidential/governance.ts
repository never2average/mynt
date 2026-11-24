import { createHmac, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "../db.js";
import { noticeFirm } from "../firm-notices.js";
import type { Store, User } from "../store.js";
import { derivedKey } from "../vault.js";

// Which builds of the confidential service Mynt trusts: each one an image digest, announced before it counts.
//
// The cloud project's key policy is what really decides which image can use the keys (docs/reference.md, Confidential
// computing), and only the operator can change it. This record is what Mynt holds itself to, and what partners check
// against: Mynt's server refuses to talk to a service whose attested digest isn't in effect here, and every
// announcement is audited, told to every licence-provider firm (a notice to each member and the
// confidential.release_announced event on its webhooks), and in effect only after the same 48 hours a mainnet program
// upgrade waits, so a partner who doesn't like a new build can stop sending sealed statements before it reads one.
// The very first release takes effect at once: there's nothing before it to protect.
//
// Each row is MACed under a key derived from the vault, so someone who can only write the database can't plant a digest.

const T = "financial_products";
export const RELEASE_TIMELOCK_MS = 48 * 3_600_000;
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const TABLES = `
  CREATE TABLE IF NOT EXISTS ${T}.confidential_releases (
    id uuid PRIMARY KEY,
    image_digest text NOT NULL,
    release text NOT NULL,
    reason text NOT NULL,
    announced_by uuid,
    announced_at timestamptz NOT NULL DEFAULT now(),
    effective_at timestamptz NOT NULL,
    withdrawn_at timestamptz,
    mac text NOT NULL
  );
  -- What the confidential host keeps for Mynt: the sealed vault keys (vault.ts), one row per name.
  CREATE TABLE IF NOT EXISTS ${T}.confidential_keys (
    name text PRIMARY KEY,
    sealed text NOT NULL,
    host text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

export interface Release {
  id: string;
  image_digest: string;
  release: string;
  reason: string;
  announced_at: string;
  effective_at: string;
  withdrawn_at: string | null;
  in_effect: boolean;
  valid: boolean; // the row's MAC checks out
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

function mac(r: { id: string; image_digest: string; release: string; effective_at: string }): string {
  const key = derivedKey("confidential-releases");
  if (!key) throw new Error("Announcing a release needs the vault (MYNT_VAULT_KEY, or the confidential host's released keys)");
  return createHmac("sha256", key).update(`${r.id}\u0000${r.image_digest}\u0000${r.release}\u0000${r.effective_at}`).digest("hex");
}

export class ConfidentialReleases {
  private constructor(
    private readonly db: Db,
    private readonly now: () => Date,
  ) {}

  static async open(db: Db, now: () => Date = () => new Date()) {
    await db.exec(TABLES);
    return new ConfidentialReleases(db, now);
  }

  async list(): Promise<Release[]> {
    const { rows } = await this.db.query(`SELECT * FROM ${T}.confidential_releases ORDER BY announced_at DESC`);
    const now = this.now().getTime();
    return rows.map((r) => {
      const base = { id: r.id as string, image_digest: r.image_digest as string, release: r.release as string, effective_at: iso(r.effective_at)! };
      let valid = false;
      try {
        valid = mac(base) === r.mac;
      } catch {
        valid = false;
      }
      return {
        ...base,
        reason: r.reason as string,
        announced_at: iso(r.announced_at)!,
        withdrawn_at: iso(r.withdrawn_at),
        valid,
        in_effect: valid && !r.withdrawn_at && new Date(base.effective_at).getTime() <= now,
      };
    });
  }

  // The digests Mynt's server will talk to now.
  async inEffect(): Promise<string[]> {
    return [...new Set((await this.list()).filter((r) => r.in_effect).map((r) => r.image_digest))];
  }

  async announce(store: Store, user: User, a: { image_digest: string; release: string; reason: string }): Promise<Release & { told_firms: number }> {
    if (!DIGEST_PATTERN.test(a.image_digest)) throw new Error("image_digest is sha256: and 64 lowercase hex digits, as CI prints it");
    const all = await this.list();
    if (all.some((r) => r.image_digest === a.image_digest && !r.withdrawn_at)) throw new Error("That digest is already announced");
    const first = all.filter((r) => r.valid).length === 0;
    const id = randomUUID();
    const effective_at = new Date(this.now().getTime() + (first ? 0 : RELEASE_TIMELOCK_MS)).toISOString();
    await this.db.query(
      `INSERT INTO ${T}.confidential_releases (id, image_digest, release, reason, announced_by, effective_at, mac) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, a.image_digest, a.release, a.reason, user.id, effective_at, mac({ id, image_digest: a.image_digest, release: a.release, effective_at })],
    );
    await store.audit(user.id, "confidential_release_announced", id, { image_digest: a.image_digest, release: a.release, reason: a.reason, effective_at });
    const firms = new Set((await store.sponsorships({ status: "approved" })).map((s) => s.provider_entity_id));
    for (const f of firms) await noticeFirm(store, f, "confidential.release_announced", { image_digest: a.image_digest, release: a.release, reason: a.reason, effective_at, verify_with: "core/scripts/verify-mynt-enclave.mjs" });
    const row = (await this.list()).find((r) => r.id === id)!;
    return { ...row, told_firms: firms.size };
  }

  // Before it takes effect, an announcement can be withdrawn (audited and told the same way); after, a newer release
  // replaces it, through the same wait.
  async withdraw(store: Store, user: User, id: string, reason: string) {
    const r = (await this.list()).find((x) => x.id === id);
    if (!r) throw new Error("No such release");
    if (r.withdrawn_at) throw new Error("Already withdrawn");
    await this.db.query(`UPDATE ${T}.confidential_releases SET withdrawn_at = now() WHERE id = $1`, [id]);
    await store.audit(user.id, "confidential_release_withdrawn", id, { image_digest: r.image_digest, reason });
    for (const f of new Set((await store.sponsorships({ status: "approved" })).map((s) => s.provider_entity_id)))
      await noticeFirm(store, f, "confidential.release_announced", { image_digest: r.image_digest, release: r.release, withdrawn: true, reason });
    return { id, withdrawn: true };
  }
}

const result = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: (e as Error).message }], isError: true });

// Licence providers, liquidity providers and admins: what partners compare an attestation's image digest against.
export function registerConfidentialTools(server: McpServer, store: Store) {
  server.registerTool(
    "list_enclave_releases",
    {
      title: "Confidential service releases",
      description:
        "Licence providers, liquidity providers and admins: the builds of Mynt's confidential service (the enclave that computes product health from partners' sealed statements and keeps Mynt's keys): each image digest, its release, why it was announced, when it takes effect (48 hours after it's announced, except the first) and whether it's in effect. Compare an attestation's image digest with these and with the digest CI published for that release (verify-mynt-enclave does both).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return result({ releases: await (await ConfidentialReleases.open(store.db)).list(), timelock_hours: RELEASE_TIMELOCK_MS / 3_600_000 });
      } catch (e) {
        return fail(e);
      }
    },
  );
}

// Admins: announce a new build (CI prints its digest), or withdraw one before it takes effect.
export function registerConfidentialAdminTools(server: McpServer, store: Store, user: User) {
  server.registerTool(
    "announce_enclave_release",
    {
      title: "Announce a confidential service release",
      description:
        "Admin: announce a build of the confidential service by its image digest (the one CI's confidential-image job printed for that commit). It takes effect 48 hours later (the first ever at once); until then Mynt's server won't talk to a service running it. Audited, and told to every licence-provider firm (a notice to each member and confidential.release_announced on its webhooks). The cloud key policy must name the same digest before the service can use its keys: the operator changes that, and docs/reference.md says how.",
      inputSchema: {
        image_digest: z.string().regex(DIGEST_PATTERN).describe("sha256:<64 hex>, as CI printed it"),
        release: z.string().min(1).max(100).describe("The commit or release tag it was built from"),
        reason: z.string().min(1).max(500).describe("What changed, for partners"),
      },
    },
    async (a) => {
      try {
        return result(await (await ConfidentialReleases.open(store.db)).announce(store, user, a));
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    "withdraw_enclave_release",
    {
      title: "Withdraw a confidential service release",
      description: "Admin: withdraw an announced build of the confidential service, so Mynt's server stops talking to it. Audited and told to every licence-provider firm.",
      inputSchema: { release_id: z.string().uuid(), reason: z.string().min(1).max(500) },
    },
    async ({ release_id, reason }) => {
      try {
        return result(await (await ConfidentialReleases.open(store.db)).withdraw(store, user, release_id, reason));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
