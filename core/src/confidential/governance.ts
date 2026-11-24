import { createHmac, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "../db.js";
import { noticeFirm } from "../firm-notices.js";
import type { Store, User } from "../store.js";
import { derivedKey } from "../vault.js";
import type { EnclavePcrs } from "./host.js";

// Which builds of the confidential service Mynt trusts, announced before they count. Each is what the hardware
// measures for that build: an enclave image's PCRs (pcr0, pcr1, pcr2, as CI's confidential-image job prints them for an
// enclave host) or a container image digest (for a confidential-VM container host).
//
// The cloud account's key policy is what really decides which image can use the keys (docs/reference.md, Confidential
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
export const PCR_PATTERN = /^[0-9a-f]{96}$/;

export const TABLES = `
  CREATE TABLE IF NOT EXISTS ${T}.confidential_releases (
    id uuid PRIMARY KEY,
    image_digest text,
    pcrs jsonb,
    release text NOT NULL,
    reason text NOT NULL,
    announced_by uuid,
    announced_at timestamptz NOT NULL DEFAULT now(),
    effective_at timestamptz NOT NULL,
    withdrawn_at timestamptz,
    mac text NOT NULL
  );
  ALTER TABLE ${T}.confidential_releases ALTER COLUMN image_digest DROP NOT NULL;
  ALTER TABLE ${T}.confidential_releases ADD COLUMN IF NOT EXISTS pcrs jsonb;
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
  kind: "image-digest" | "enclave-pcrs";
  image_digest: string | null;
  pcrs: EnclavePcrs | null;
  release: string;
  reason: string;
  announced_at: string;
  effective_at: string;
  withdrawn_at: string | null;
  in_effect: boolean;
  valid: boolean; // the row's MAC checks out
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

// What a release measures, as one string: the digest itself (as the first releases were MACed), or the three PCRs.
const measured = (r: { image_digest: string | null; pcrs: EnclavePcrs | null }) => r.image_digest ?? `pcrs:${r.pcrs!.pcr0},${r.pcrs!.pcr1},${r.pcrs!.pcr2}`;

function mac(r: { id: string; image_digest: string | null; pcrs: EnclavePcrs | null; release: string; effective_at: string }): string {
  const key = derivedKey("confidential-releases");
  if (!key) throw new Error("Announcing a release needs the vault (MYNT_VAULT_KEY, or the confidential host's released keys)");
  return createHmac("sha256", key).update(`${r.id}\u0000${measured(r)}\u0000${r.release}\u0000${r.effective_at}`).digest("hex");
}

const pcrsOf = (v: unknown): EnclavePcrs | null => {
  const p = (typeof v === "string" ? JSON.parse(v) : v) as Partial<EnclavePcrs> | null;
  return p && typeof p.pcr0 === "string" && typeof p.pcr1 === "string" && typeof p.pcr2 === "string" ? { pcr0: p.pcr0, pcr1: p.pcr1, pcr2: p.pcr2 } : null;
};

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
      const pcrs = pcrsOf(r.pcrs);
      const base = { id: r.id as string, image_digest: (r.image_digest as string | null) ?? null, pcrs, release: r.release as string, effective_at: iso(r.effective_at)! };
      let valid = false;
      try {
        valid = (base.image_digest !== null || pcrs !== null) && mac(base) === r.mac;
      } catch {
        valid = false;
      }
      return {
        id: base.id,
        kind: base.image_digest !== null ? ("image-digest" as const) : ("enclave-pcrs" as const),
        image_digest: base.image_digest,
        pcrs,
        release: base.release,
        effective_at: base.effective_at,
        reason: r.reason as string,
        announced_at: iso(r.announced_at)!,
        withdrawn_at: iso(r.withdrawn_at),
        valid,
        in_effect: valid && !r.withdrawn_at && new Date(base.effective_at).getTime() <= now,
      };
    });
  }

  // The image digests Mynt's server will talk to now (confidential-VM container hosts).
  async inEffect(): Promise<string[]> {
    return [...new Set((await this.list()).filter((r) => r.in_effect && r.image_digest).map((r) => r.image_digest!))];
  }

  // The enclave PCRs Mynt's server will talk to now (enclave hosts): all three must match one release.
  async pcrsInEffect(): Promise<EnclavePcrs[]> {
    return (await this.list()).filter((r) => r.in_effect && r.pcrs).map((r) => r.pcrs!);
  }

  async announce(store: Store, user: User, a: { image_digest?: string; pcr0?: string; pcr1?: string; pcr2?: string; release: string; reason: string }): Promise<Release & { told_firms: number }> {
    const hasPcrs = a.pcr0 !== undefined || a.pcr1 !== undefined || a.pcr2 !== undefined;
    if ((a.image_digest === undefined) === !hasPcrs) throw new Error("Announce either an image_digest (a confidential-VM container) or pcr0, pcr1 and pcr2 (an enclave image), as CI printed them");
    if (a.image_digest !== undefined && !DIGEST_PATTERN.test(a.image_digest)) throw new Error("image_digest is sha256: and 64 lowercase hex digits, as CI prints it");
    const pcrs = hasPcrs ? { pcr0: a.pcr0 ?? "", pcr1: a.pcr1 ?? "", pcr2: a.pcr2 ?? "" } : null;
    if (pcrs && ![pcrs.pcr0, pcrs.pcr1, pcrs.pcr2].every((p) => PCR_PATTERN.test(p))) throw new Error("pcr0, pcr1 and pcr2 are each 96 lowercase hex digits (SHA-384), as CI prints them");
    if (pcrs && /^0+$/.test(pcrs.pcr0)) throw new Error("All-zero PCRs are what an enclave in debug mode reports: never announce them");
    const image_digest = a.image_digest ?? null;
    const all = await this.list();
    if (all.some((r) => measured(r) === measured({ image_digest, pcrs }) && !r.withdrawn_at)) throw new Error("That build is already announced");
    const first = all.filter((r) => r.valid).length === 0;
    const id = randomUUID();
    const effective_at = new Date(this.now().getTime() + (first ? 0 : RELEASE_TIMELOCK_MS)).toISOString();
    await this.db.query(
      `INSERT INTO ${T}.confidential_releases (id, image_digest, pcrs, release, reason, announced_by, effective_at, mac) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, image_digest, pcrs ? JSON.stringify(pcrs) : null, a.release, a.reason, user.id, effective_at, mac({ id, image_digest, pcrs, release: a.release, effective_at })],
    );
    const what = image_digest ? { image_digest } : { pcrs };
    await store.audit(user.id, "confidential_release_announced", id, { ...what, release: a.release, reason: a.reason, effective_at });
    const firms = new Set((await store.sponsorships({ status: "approved" })).map((s) => s.provider_entity_id));
    for (const f of firms) await noticeFirm(store, f, "confidential.release_announced", { ...what, release: a.release, reason: a.reason, effective_at, verify_with: "core/scripts/verify-mynt-enclave.mjs" });
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
    const what = r.image_digest ? { image_digest: r.image_digest } : { pcrs: r.pcrs };
    await store.audit(user.id, "confidential_release_withdrawn", id, { ...what, reason });
    for (const f of new Set((await store.sponsorships({ status: "approved" })).map((s) => s.provider_entity_id)))
      await noticeFirm(store, f, "confidential.release_announced", { ...what, release: r.release, withdrawn: true, reason });
    return { id, withdrawn: true };
  }
}

const result = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: (e as Error).message }], isError: true });

// Licence providers, liquidity providers and admins: what partners compare an attestation's measurements against.
export function registerConfidentialTools(server: McpServer, store: Store) {
  server.registerTool(
    "list_enclave_releases",
    {
      title: "Confidential service releases",
      description:
        "Licence providers, liquidity providers and admins: the builds of Mynt's confidential service (the enclave that computes product health from partners' sealed statements and keeps Mynt's keys): what the hardware measures for each (an enclave image's pcr0, pcr1 and pcr2, or a container image digest), its release, why it was announced, when it takes effect (48 hours after it's announced, except the first) and whether it's in effect. Compare an attestation's measurements with these and with the ones CI published for that release (verify-mynt-enclave does both).",
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

// Admins: announce a new build (CI prints its measurements), or withdraw one before it takes effect.
export function registerConfidentialAdminTools(server: McpServer, store: Store, user: User) {
  server.registerTool(
    "announce_enclave_release",
    {
      title: "Announce a confidential service release",
      description:
        "Admin: announce a build of the confidential service by what the hardware measures, as CI's confidential-image job printed it for that commit: pcr0, pcr1 and pcr2 for the enclave image (the default host), or image_digest for a confidential-VM container. It takes effect 48 hours later (the first ever at once); until then Mynt's server won't talk to a service running it. Audited, and told to every licence-provider firm (a notice to each member and confidential.release_announced on its webhooks). The cloud key policy must name the same measurement (an enclave's pcr0) before the service can use its keys: the operator changes that, and docs/reference.md says how.",
      inputSchema: {
        pcr0: z.string().regex(PCR_PATTERN).optional().describe("Enclave image: 96 lowercase hex digits, as CI printed it"),
        pcr1: z.string().regex(PCR_PATTERN).optional().describe("Enclave kernel and boot ramdisk"),
        pcr2: z.string().regex(PCR_PATTERN).optional().describe("Enclave application"),
        image_digest: z.string().regex(DIGEST_PATTERN).optional().describe("Confidential-VM container instead: sha256:<64 hex>, as CI printed it"),
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
