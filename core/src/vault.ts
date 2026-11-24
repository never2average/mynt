import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { DATA_DICTIONARY, type CaptureMethod } from "./data-dictionary.js";

// The customer vault: data a customer gave (or let Mynt fetch) once, kept per app and customer reference,
// encrypted at rest (AES-256-GCM) so it can prefill the next journey instead of being asked for again.
// Live data uses the vault key; sandbox data uses a key that exists only in this process, so test data never
// outlives a restart. Values are never returned to devices: only which fields are held, masked.
//
// The vault key is MYNT_VAULT_KEY (32 bytes, base64) until the operator moves it into the confidential host
// (confidential/index.ts, docs/reference.md "Confidential computing"). After that, the host releases two keys into this
// process at boot, and MYNT_VAULT_KEY can be removed from the server:
//   - a data key: new values are sealed with it (format v2), and the migration re-wraps every v1 value to it;
//   - HKDF-Extract of MYNT_VAULT_KEY: every key derived from it (derivedKey, the durable sandbox key) is HKDF-Expand of
//     that, so they stay exactly what they were (MACs still check, on-chain subject hashes don't move), while the root
//     itself, which opens every v1 value, stays inside the host.

let ephemeral: Buffer | null = null;
let released: { data: Buffer; prk: Buffer } | null = null;

export function legacyVaultRoot(): Buffer | null {
  const raw = process.env.MYNT_VAULT_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

// Called once at boot by bootVault (confidential/index.ts) with what the confidential host released.
export function installReleasedVaultKeys(dataKey: Buffer, derivationPrk: Buffer) {
  if (dataKey.length !== 32 || derivationPrk.length !== 32) throw new Error("released vault keys are 32 bytes each");
  released = { data: Buffer.from(dataKey), prk: Buffer.from(derivationPrk) };
}
export const vaultKeysReleased = () => released !== null;

// The key new live values are sealed with, and which format that makes.
function sealingKey(sandbox: boolean): { key: Buffer; v: "v1" | "v2" } | null {
  if (sandbox) return { key: (ephemeral ??= randomBytes(32)), v: "v1" };
  if (released) return { key: released.data, v: "v2" };
  const legacy = legacyVaultRoot();
  return legacy ? { key: legacy, v: "v1" } : null;
}

export const vaultAvailable = (sandbox: boolean) => sealingKey(sandbox) !== null;

// HKDF-SHA256 with an empty salt, from MYNT_VAULT_KEY or, once released, from its extract: the same key either way.
function derive(info: string): Buffer | null {
  if (released) return createHmac("sha256", released.prk).update(Buffer.concat([Buffer.from(info, "utf8"), Buffer.from([1])])).digest();
  const legacy = legacyVaultRoot();
  return legacy ? Buffer.from(hkdfSync("sha256", legacy, Buffer.alloc(0), info, 32)) : null;
}

// Sandbox data that must outlive a restart (vendors' results queued for an innovator's webhook): a key derived
// from the vault key under its own label, so it never opens live data and live data never opens with it.
const durableSandboxKey = (): Buffer | null => derive("mynt-sandbox-durable-v1");

// A key for one purpose (e.g. signing the Mynt Ramp's own quotes), derived from the vault key under its own label.
export const derivedKey = (label: string): Buffer | null => derive(`mynt-derived-v1:${label}`);

function sealWith(key: Buffer, v: string, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [v, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}
function openWith(key: Buffer, iv: string, tag: string, ct: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

// `durable` matters for sandbox only: sealed with the derived key (marked v1s) when the vault key is there.
export function seal(value: string, sandbox: boolean, durable = false): string {
  const derived = sandbox && durable ? durableSandboxKey() : null;
  if (derived) return sealWith(derived, "v1s", value);
  const k = sealingKey(sandbox);
  if (!k) throw new Error("vault key not configured");
  return sealWith(k.key, k.v, value);
}

export function open(sealed: string, sandbox: boolean): string {
  const [v, iv, tag, ct] = sealed.split(":");
  if (v === "v1s" && sandbox) {
    const key = durableSandboxKey();
    if (!key) throw new Error("vault key not configured");
    return openWith(key, iv, tag, ct);
  }
  if (v === "v2" && !sandbox) {
    if (!released) throw new Error("vault key not configured: this value was sealed with the confidential host's data key");
    return openWith(released.data, iv, tag, ct);
  }
  if (v !== "v1") throw new Error("unknown vault format");
  const key = sandbox ? (ephemeral ??= randomBytes(32)) : legacyVaultRoot();
  if (!key) throw new Error(released ? "This value is still sealed with MYNT_VAULT_KEY: run `mynt confidential rewrap --apply` with it set" : "vault key not configured");
  return openWith(key, iv, tag, ct);
}

// ---- the migration (confidential/index.ts: rewrapVault) ----

// A live value sealed with MYNT_VAULT_KEY, with hosting's ":live"/":sandbox" suffix allowed.
export const LEGACY_SEALED = /^v1:[A-Za-z0-9+/=]{16}:[A-Za-z0-9+/=]{24}:[A-Za-z0-9+/=]*(:live|:sandbox)?$/;

// The same value sealed with the released data key, or null when it doesn't open with MYNT_VAULT_KEY (a sandbox value
// sealed by an earlier process's own key, say). `check`: only whether it would open.
export function rewrapLegacyValue(value: string, check = false): string | null {
  const legacy = legacyVaultRoot();
  if (!LEGACY_SEALED.test(value) || !legacy) return null;
  const suffix = value.endsWith(":live") ? ":live" : value.endsWith(":sandbox") ? ":sandbox" : "";
  const [, iv, tag, ct] = (suffix ? value.slice(0, -suffix.length) : value).split(":");
  let plain: string;
  try {
    plain = openWith(legacy, iv, tag, ct);
  } catch {
    return null;
  }
  if (check) return value;
  if (!released) throw new Error("The confidential host hasn't released the vault's data key: run `mynt confidential adopt` and restart first");
  return sealWith(released.data, "v2", plain) + suffix;
}

// What a device may see of a held value: public values as they are, others masked to their last 4.
export function masked(field: string, value: string): string {
  const f = DATA_DICTIONARY[field];
  if (!f || f.sensitivity === "public") return value;
  return value.length <= 4 ? "•".repeat(value.length) : "•".repeat(Math.min(8, value.length - 4)) + value.slice(-4);
}

// A value checked against the dictionary: its type, pattern and allowed values.
export function validateValue(field: string, value: unknown): string | null {
  const f = DATA_DICTIONARY[field];
  if (!f) return `${field} isn't in Mynt's data dictionary`;
  const s = typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "boolean" ? String(value) : null;
  if (s === null || !s) return `${field}: a value is required`;
  if (s.length > 500) return `${field}: too long`;
  if ((f.type === "number" || f.type === "integer") && !(f.type === "integer" ? /^-?\d+$/ : /^-?\d+(\.\d+)?$/).test(s)) return `${field}: expected a ${f.type}`;
  if (f.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${field}: expected YYYY-MM-DD`;
  if (f.type === "enum" && !f.enum?.includes(s)) return `${field}: expected one of ${f.enum?.join(", ")}`;
  if (f.pattern && !new RegExp(f.pattern).test(s)) return `${field}: not a valid ${f.label}`;
  return null;
}

// Sandbox prefill: realistic fixture values per source, so journeys can be built and tested end to end
// before a live Account Aggregator, DigiLocker or CKYC connector is configured.
const FIXTURES: Record<string, string> = {
  full_name: "Asha Verma",
  date_of_birth: "1991-04-12",
  address: "12 MG Road, Bengaluru",
  pin_code: "560001",
  pan: "ABCPV1234K",
  aadhaar_reference: "XXXX-XXXX-4321",
  monthly_income: "85000",
  bank_account_number: "123456789012",
  ifsc: "HDFC0001234",
  bank_statement_6m: "aa://sandbox/statements/6m",
  annual_turnover: "4200000",
};
// A fixture value for any dictionary field, for Mynt's conformance tests of vendors' services.
const EXTRA_FIXTURES: Record<string, string> = { ssn: "123-45-6789", routing_number: "021000021", mobile_number: "+919800000001", email: "asha@example.com", amount: "5000" };
export const fixtureValue = (field: string): string | null => FIXTURES[field] ?? EXTRA_FIXTURES[field] ?? null;

export function sandboxPrefill(field: string, source: CaptureMethod): string | null {
  const f = DATA_DICTIONARY[field];
  return f?.capture.includes(source) ? (FIXTURES[field] ?? null) : null;
}
