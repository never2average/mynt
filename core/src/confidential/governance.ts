import { createHmac, createPrivateKey, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "../db.js";
import { noticeFirm } from "../firm-notices.js";
import type { Store, User } from "../store.js";
import { derivedKey, vaultKeysReleased } from "../vault.js";
import type { EnclavePcrs } from "./host.js";

// Which builds of the confidential service Mynt trusts, announced before they count. Each is what the hardware
// measures for that build: an enclave image's PCRs (pcr0, pcr1, pcr2, as CI's confidential-image job prints them for an
// enclave host) or a container image digest (for a confidential-VM container host).
//
// The cloud account's key policy is what really decides which image can use the keys (docs/reference/confidential-computing.md,
// The key policy), and only the operator can change it. This record is what Mynt holds itself to, and what partners check
// against: Mynt's server refuses to talk to a service whose attested digest isn't in effect here, and every
// announcement is audited, told to every licence-provider firm (a notice to each member and the
// confidential.release_announced event on its webhooks), and in effect only after the same 48 hours a mainnet program
// upgrade waits, so a partner who doesn't like a new build can stop sending sealed statements before it reads one.
// The very first release takes effect at once: there's nothing before it to protect. "First" means no sign that there
// was ever one before (everAnnounced), not merely an empty table: emptying the table doesn't buy an immediate release.
//
// Each row is MACed, so someone who can only write the database can't plant a build, bring a withdrawn one back or
// move the moment one takes effect. The MAC covers the row's id, what it measures, its release, when it takes effect
// and when it was withdrawn. The key has to be there before the confidential service is trusted, because these rows
// are what decide whether it is: on a server set to a confidential service that's a key derived from the server's
// client key for it (CONFIDENTIAL_HOST_CLIENT_KEY, a file the server already keeps and a database writer doesn't
// have), so the rows check out at boot with no vault key on disk, before the vault is released. On the local host
// it's a key derived from the vault, as it always was. Rows that can't be authenticated are never in effect.
//
// A MAC can't tell a row from an older, equally authentic copy of itself: someone who can write the database and kept
// a release's row from before it was withdrawn could put that copy back. So a withdrawal is also remembered outside
// the row: in this process for as long as it runs, and in the audit log, whose record of a withdrawal makes the
// release withdrawn whatever its row says. What that leaves is in docs/reference/confidential-computing.md.

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

type MacRow = { id: string; image_digest: string | null; pcrs: EnclavePcrs | null; release: string; effective_at: string; withdrawn_at: string | null };

// The keys release rows are MACed under. `scheme` says which one new rows use: "c" the client-key one (a server set to
// a confidential service), "v" the vault-derived one (the local host). `vault` also reads rows from before (the first
// format, and rows announced while the server was still on the local host); `previous` reads rows MACed under the
// client key this server had before it was replaced (CONFIDENTIAL_HOST_PREVIOUS_CLIENT_KEY, a path, set for one start).
export interface ReleaseMacKeys {
  scheme: "c" | "v";
  current: Buffer | null;
  vault: Buffer | null;
  previous: Buffer | null;
}

const MAC_INFO = "mynt-confidential-releases-v2";
const clientKeyCache = new Map<string, Buffer>();
// A MAC key from a private key file: HKDF of the key itself (its PKCS#8 encoding), so the same key in another PEM
// wrapping gives the same MAC key. Null when the file can't be read: rows then don't authenticate.
function macKeyFromPrivateKey(path: string | undefined): Buffer | null {
  if (!path) return null;
  if (!clientKeyCache.has(path)) {
    let key: Buffer | null = null;
    try {
      const der = createPrivateKey(readFileSync(path, "utf8")).export({ type: "pkcs8", format: "der" });
      key = Buffer.from(hkdfSync("sha256", der, Buffer.alloc(0), MAC_INFO, 32));
    } catch {
      key = null;
    }
    if (!key) return null; // not remembered: the file may be put right without a restart
    clientKeyCache.set(path, key);
  }
  return clientKeyCache.get(path) ?? null;
}

export function releaseMacKeysFromEnv(env: NodeJS.ProcessEnv = process.env): ReleaseMacKeys {
  const vault = derivedKey("confidential-releases");
  if ((env.CONFIDENTIAL_HOST || "local") === "local") return { scheme: "v", current: vault, vault, previous: null };
  return { scheme: "c", current: macKeyFromPrivateKey(env.CONFIDENTIAL_HOST_CLIENT_KEY), vault, previous: macKeyFromPrivateKey(env.CONFIDENTIAL_HOST_PREVIOUS_CLIENT_KEY) };
}

// The first format: no withdrawal, under the vault-derived key. Read, and replaced when the row is next authenticated.
const macV1 = (key: Buffer, r: MacRow) => createHmac("sha256", key).update(`${r.id}\u0000${measured(r)}\u0000${r.release}\u0000${r.effective_at}`).digest("hex");
const macV2 = (key: Buffer, r: MacRow) => createHmac("sha256", key).update(JSON.stringify([MAC_INFO, r.id, measured(r), r.release, r.effective_at, r.withdrawn_at])).digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

function newMac(keys: ReleaseMacKeys, r: MacRow): string {
  if (!keys.current)
    throw new Error(
      keys.scheme === "c"
        ? "The release record is authenticated with a key from this server's client key for the confidential service (CONFIDENTIAL_HOST_CLIENT_KEY), which can't be read"
        : "The release record is authenticated with a key from the vault (MYNT_VAULT_KEY), which isn't set",
    );
  return `v2${keys.scheme}:${macV2(keys.current, r)}`;
}

// Whether a stored MAC authenticates the row, and whether it should be replaced with one under the current key.
function checkMac(keys: ReleaseMacKeys, r: MacRow, stored: unknown): { valid: boolean; stale: boolean } {
  const no = { valid: false, stale: false };
  if (typeof stored !== "string" || !stored) return no;
  if (stored.startsWith("v2c:")) {
    const m = stored.slice(4);
    if (keys.scheme === "c" && keys.current && same(m, macV2(keys.current, r))) return { valid: true, stale: false };
    if (keys.scheme === "c" && keys.previous && same(m, macV2(keys.previous, r))) return { valid: true, stale: true };
    return no;
  }
  if (stored.startsWith("v2v:")) return keys.vault && same(stored.slice(4), macV2(keys.vault, r)) ? { valid: true, stale: keys.scheme === "c" } : no;
  return keys.vault && same(stored, macV1(keys.vault, r)) ? { valid: true, stale: true } : no;
}

const pcrsOf = (v: unknown): EnclavePcrs | null => {
  const p = (typeof v === "string" ? JSON.parse(v) : v) as Partial<EnclavePcrs> | null;
  return p && typeof p.pcr0 === "string" && typeof p.pcr1 === "string" && typeof p.pcr2 === "string" ? { pcr0: p.pcr0, pcr1: p.pcr1, pcr2: p.pcr2 } : null;
};

// Releases this process withdrew: never in effect again while it runs, whatever the database comes to say.
const withdrawnHere = new Set<string>();

export class ConfidentialReleases {
  private constructor(
    private readonly db: Db,
    private readonly now: () => Date,
    private readonly keys: () => ReleaseMacKeys,
  ) {}

  // `keys`: tests. Otherwise from the server's settings, read each time (the vault's keys arrive after boot).
  static async open(db: Db, now: () => Date = () => new Date(), keys: () => ReleaseMacKeys = () => releaseMacKeysFromEnv()) {
    await db.exec(TABLES);
    const releases = new ConfidentialReleases(db, now, keys);
    await releases.reauthenticate();
    return releases;
  }

  // The releases the audit log says were withdrawn; null when it can't be read, and then nothing is in effect.
  private async auditedWithdrawals(): Promise<Set<string> | null> {
    try {
      const { rows } = await this.db.query(`SELECT target FROM ${T}.audit_log WHERE action = 'confidential_release_withdrawn'`);
      return new Set(rows.map((r) => r.target as string));
    } catch {
      return null;
    }
  }

  private async rows() {
    const { rows } = await this.db.query(`SELECT * FROM ${T}.confidential_releases ORDER BY announced_at DESC`);
    const keys = this.keys();
    const audited = rows.length ? await this.auditedWithdrawals() : new Set<string>();
    return rows.map((r) => {
      const base: MacRow = { id: r.id as string, image_digest: (r.image_digest as string | null) ?? null, pcrs: pcrsOf(r.pcrs), release: r.release as string, effective_at: iso(r.effective_at)!, withdrawn_at: iso(r.withdrawn_at) };
      let check = { valid: false, stale: false };
      try {
        if (base.image_digest !== null || base.pcrs !== null) check = checkMac(keys, base, r.mac);
      } catch {
        check = { valid: false, stale: false };
      }
      // Withdrawn, by this process or by the audit log's account, but the row says it isn't: an older copy put back.
      if (!base.withdrawn_at && (!audited || audited.has(base.id) || withdrawnHere.has(base.id))) check = { valid: false, stale: false };
      return { r, base, ...check };
    });
  }

  // Rows that authenticate under a key this server is moving away from (the first format; the vault-derived key, once
  // the server is set to a confidential service; the client key it had before) are MACed again under the current one,
  // while the old key is still at hand. Each update is conditional on the MAC it read, and a row that doesn't
  // authenticate is left exactly as it is. A row in the first format is trusted for its withdrawal as it stands (that
  // format never covered it); from here on it's covered.
  async reauthenticate(): Promise<number> {
    const keys = this.keys();
    if (!keys.current) return 0;
    let done = 0;
    for (const x of await this.rows()) {
      if (!x.valid || !x.stale) continue;
      const u = await this.db.query(`UPDATE ${T}.confidential_releases SET mac = $1 WHERE id = $2 AND mac = $3 RETURNING 1 AS done`, [newMac(keys, x.base), x.base.id, x.r.mac]);
      done += u.rows.length;
    }
    return done;
  }

  async list(): Promise<Release[]> {
    const now = this.now().getTime();
    return (await this.rows()).map(({ r, base, valid }) => {
      const pcrs = base.pcrs;
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
    // Not "no valid rows": then emptying the table (or breaking every MAC) would let the next build in at once.
    const first = all.length === 0 && !(await this.everAnnounced());
    const id = randomUUID();
    const effective_at = new Date(this.now().getTime() + (first ? 0 : RELEASE_TIMELOCK_MS)).toISOString();
    await this.db.query(
      `INSERT INTO ${T}.confidential_releases (id, image_digest, pcrs, release, reason, announced_by, effective_at, mac) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, image_digest, pcrs ? JSON.stringify(pcrs) : null, a.release, a.reason, user.id, effective_at, newMac(this.keys(), { id, image_digest, pcrs, release: a.release, effective_at, withdrawn_at: null })],
    );
    const what = image_digest ? { image_digest } : { pcrs };
    await store.audit(user.id, "confidential_release_announced", id, { ...what, release: a.release, reason: a.reason, effective_at });
    const firms = new Set((await store.sponsorships({ status: "approved" })).map((s) => s.provider_entity_id));
    for (const f of firms) await noticeFirm(store, f, "confidential.release_announced", { ...what, release: a.release, reason: a.reason, effective_at, verify_with: "core/scripts/verify-mynt-enclave.mjs" });
    const row = (await this.list()).find((r) => r.id === id)!;
    return { ...row, told_firms: firms.size };
  }

  // Whether anything says a release was ever announced here, beyond the table itself: the audit log's record of one,
  // anything the confidential host keeps for Mynt (its root or the vault's keys, neither of which exists before a
  // release was in effect), or a vault this very process had released by a host. Any of them, or a failure to look,
  // means the next announcement waits like every other. Someone who can delete from all of those tables on a server
  // that hasn't the vault released can still reset it: docs/reference/confidential-computing.md says so.
  private async everAnnounced(): Promise<boolean> {
    if (vaultKeysReleased()) return true;
    try {
      const kept = await this.db.query(`SELECT 1 AS x FROM ${T}.confidential_keys LIMIT 1`);
      if (kept.rows.length) return true;
      const audited = await this.db.query(`SELECT 1 AS x FROM ${T}.audit_log WHERE action IN ('confidential_release_announced', 'confidential_release_withdrawn') LIMIT 1`);
      return audited.rows.length > 0;
    } catch {
      return true;
    }
  }

  // Before it takes effect, an announcement can be withdrawn (audited and told the same way); after, a newer release
  // replaces it, through the same wait. The withdrawal is part of what the row's MAC covers: clearing withdrawn_at in
  // the database leaves a row that no longer authenticates, never one back in effect.
  async withdraw(store: Store, user: User, id: string, reason: string) {
    const r = (await this.list()).find((x) => x.id === id);
    if (!r) throw new Error("No such release");
    if (r.withdrawn_at) throw new Error("Already withdrawn");
    const withdrawn_at = this.now().toISOString();
    const mac = newMac(this.keys(), { id: r.id, image_digest: r.image_digest, pcrs: r.pcrs, release: r.release, effective_at: r.effective_at, withdrawn_at });
    const done = await this.db.query(`UPDATE ${T}.confidential_releases SET withdrawn_at = $2, mac = $3 WHERE id = $1 AND withdrawn_at IS NULL RETURNING 1 AS done`, [id, withdrawn_at, mac]);
    if (!done.rows.length) throw new Error("Already withdrawn");
    withdrawnHere.add(id);
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
        "Admin: announce a build of the confidential service by what the hardware measures, as CI's confidential-image job printed it for that commit: pcr0, pcr1 and pcr2 for the enclave image (the default host), or image_digest for a confidential-VM container. It takes effect 48 hours later (the first ever at once); until then Mynt's server won't talk to a service running it. Audited, and told to every licence-provider firm (a notice to each member and confidential.release_announced on its webhooks). The cloud key policy must name the same measurement (an enclave's pcr0) before the service can use its keys: the operator changes that, and docs/reference/confidential-computing.md (The key policy) says how.",
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
