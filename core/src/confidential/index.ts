// Picks the confidential host from the environment. Provider names appear here and in their adapters only.
import type { Db } from "../db.js";
import { installReleasedVaultKeys, legacyVaultRoot, rewrapLegacyValue, LEGACY_SEALED } from "../vault.js";
import { NitroEnclaveHost, nitroHostOptionsFromEnv } from "./aws-nitro.js";
import { ConfidentialSpaceHost, remoteHostOptionsFromEnv } from "./gcp-confidential-space.js";
import { ConfidentialReleases, TABLES } from "./governance.js";
import { CONFIDENTIAL_HOST_KINDS, ConfidentialRefused, type ConfidentialHost } from "./host.js";
import { LocalConfidentialHost } from "./local.js";

export * from "./host.js";
export { ConfidentialReleases } from "./governance.js";
export { LocalConfidentialHost } from "./local.js";

// CONFIDENTIAL_HOST: local (the default), aws-nitro (the documented deployment) or gcp-confidential-space, with
// CONFIDENTIAL_HOST_URL, CONFIDENTIAL_HOST_CLIENT_CERT and CONFIDENTIAL_HOST_CLIENT_KEY (paths to files, never the
// material), and for aws-nitro CONFIDENTIAL_HOST_KMS_KEY (the wrap key's ARN). With a database, an enclave that
// restarted gets its wrapped root back from it (`mynt confidential init` stored it).
export function confidentialHostFromEnv(env: NodeJS.ProcessEnv, releases: ConfidentialReleases | null, db?: Db): ConfidentialHost {
  const kind = env.CONFIDENTIAL_HOST || "local";
  if (!(CONFIDENTIAL_HOST_KINDS as readonly string[]).includes(kind)) throw new ConfidentialRefused(`CONFIDENTIAL_HOST must be one of ${CONFIDENTIAL_HOST_KINDS.join(", ")}`);
  if (kind === "local") return new LocalConfidentialHost();
  if (!releases) throw new ConfidentialRefused("The confidential service needs the release record");
  if (kind === "aws-nitro") return new NitroEnclaveHost(nitroHostOptionsFromEnv(env, () => releases.pcrsInEffect(), db ? () => storedWrappedRoot(db, kind) : undefined));
  return new ConfidentialSpaceHost(remoteHostOptionsFromEnv(env, () => releases.inEffect()));
}

const T = "financial_products";
const VAULT_KEYS = "vault-keys";
const HOST_ROOT = "host-root";

export async function storedWrappedRoot(db: Db, host: string): Promise<string | null> {
  const { rows } = await db.query(`SELECT sealed FROM ${T}.confidential_keys WHERE name = $1 AND host = $2`, [HOST_ROOT, host]);
  return (rows[0]?.sealed as string | undefined) ?? null;
}

// Once, on a new confidential service: it makes its root and returns it wrapped (ciphertext only it can unwrap). On a
// host that keeps nothing across restarts (an enclave), Mynt stores the wrapped root and hands it back after each
// restart, so the operator has nothing to copy; elsewhere the operator puts it in the VM's settings.
export async function initialiseHost(db: Db, host: ConfidentialHost): Promise<{ wrapped_root: string; stored: boolean }> {
  if (!host.initialise) throw new ConfidentialRefused("This confidential host has no root to initialise");
  await db.exec(TABLES);
  if (host.unlock && (await storedWrappedRoot(db, host.kind))) throw new ConfidentialRefused("This confidential service already has a root (Mynt keeps it wrapped): initialising again would orphan everything sealed under it");
  const { wrapped_root } = await host.initialise();
  if (!host.unlock) return { wrapped_root, stored: false };
  await db.query(`INSERT INTO ${T}.confidential_keys (name, sealed, host) VALUES ($1, $2, $3)`, [HOST_ROOT, wrapped_root, host.kind]);
  await host.unlock(wrapped_root);
  return { wrapped_root, stored: true };
}

// At boot: when the vault's keys were adopted by the host, release them into this process (vault.ts). They live only in
// memory. Returns whether they were; false means MYNT_VAULT_KEY is still the vault's key, as before the migration.
export async function bootVault(db: Db, host: ConfidentialHost): Promise<boolean> {
  await db.exec(TABLES);
  const { rows } = await db.query(`SELECT sealed, host FROM ${T}.confidential_keys WHERE name = $1`, [VAULT_KEYS]);
  const row = rows[0] as { sealed: string; host: string } | undefined;
  if (!row) return false;
  if (row.host !== host.kind) throw new ConfidentialRefused(`The vault's keys were adopted by the ${row.host} confidential host, but this server is set to ${host.kind}`);
  const released = await host.releaseVaultKeys(row.sealed);
  installReleasedVaultKeys(released.data_key, released.derivation_prk);
  return true;
}

// Step 1 of the migration (docs/reference.md, Confidential computing): the host adopts MYNT_VAULT_KEY, sealed with a
// fresh data key, and the sealed bundle is stored. Once only.
export async function adoptVault(db: Db, host: ConfidentialHost): Promise<{ adopted: boolean; host: string }> {
  const root = legacyVaultRoot();
  if (!root) throw new ConfidentialRefused("MYNT_VAULT_KEY isn't set (or isn't 32 bytes, base64): there's nothing to adopt");
  await db.exec(TABLES);
  const { rows } = await db.query(`SELECT host FROM ${T}.confidential_keys WHERE name = $1`, [VAULT_KEYS]);
  if (rows.length) return { adopted: false, host: rows[0].host as string };
  const sealed = await host.adoptVaultRoot(root);
  await db.query(`INSERT INTO ${T}.confidential_keys (name, sealed, host) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`, [VAULT_KEYS, sealed, host.kind]);
  return { adopted: true, host: host.kind };
}

export interface RewrapCount {
  table: string;
  column: string;
  legacy: number; // values sealed with MYNT_VAULT_KEY
  rewrapped: number;
  unopenable: number; // matched the format but didn't open with MYNT_VAULT_KEY (sandbox values from a past process)
}

// Step 2: every value sealed with MYNT_VAULT_KEY, in every text column of Mynt's schema, sealed again with the released
// data key. A dry run counts and changes nothing. Idempotent, one row at a time, each update conditional on the value
// not having changed since it was read, so it can run beside a live server and be run again.
export async function rewrapVault(db: Db, opts: { apply: boolean }): Promise<{ dry_run: boolean; columns: RewrapCount[]; total_legacy: number; total_rewrapped: number }> {
  if (opts.apply && !legacyVaultRoot()) throw new ConfidentialRefused("Re-wrapping opens each value with MYNT_VAULT_KEY: keep it set until this has run");
  const { rows: cols } = await db.query(
    `SELECT c.table_name, c.column_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = $1 AND c.data_type = 'text' AND t.table_type = 'BASE TABLE' ORDER BY 1, 2`,
    [T],
  );
  const out: RewrapCount[] = [];
  for (const c of cols as { table_name: string; column_name: string }[]) {
    const tq = `${T}."${c.table_name.replaceAll('"', "")}"`;
    const cq = `"${c.column_name.replaceAll('"', "")}"`;
    const { rows } = await db.query(`SELECT ctid::text AS rid, ${cq} AS v FROM ${tq} WHERE ${cq} ~ $1`, [LEGACY_SEALED.source]);
    if (!rows.length) continue;
    const count: RewrapCount = { table: c.table_name, column: c.column_name, legacy: 0, rewrapped: 0, unopenable: 0 };
    for (const r of rows as { rid: string; v: string }[]) {
      const next = rewrapLegacyValue(r.v, !opts.apply);
      if (next === null) {
        count.unopenable++;
        continue;
      }
      count.legacy++;
      if (!opts.apply) continue;
      const u = await db.query(`UPDATE ${tq} SET ${cq} = $1 WHERE ctid = $2::tid AND ${cq} = $3 RETURNING 1 AS done`, [next, r.rid, r.v]);
      if (u.rows.length) count.rewrapped++;
    }
    out.push(count);
  }
  return { dry_run: !opts.apply, columns: out, total_legacy: out.reduce((a, c) => a + c.legacy, 0), total_rewrapped: out.reduce((a, c) => a + c.rewrapped, 0) };
}
