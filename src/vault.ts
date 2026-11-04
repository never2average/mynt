import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { DATA_DICTIONARY, type CaptureMethod } from "./data-dictionary.js";

// The customer vault: data a customer gave (or let Mynt fetch) once, kept per app and customer reference,
// encrypted at rest (AES-256-GCM) so it can prefill the next journey instead of being asked for again.
// Live data uses MYNT_VAULT_KEY (32 bytes, base64); sandbox data uses a key that exists only in this
// process, so test data never outlives a restart. Values are never returned to devices: only which
// fields are held, masked.

let ephemeral: Buffer | null = null;
function keyFor(sandbox: boolean): Buffer | null {
  if (sandbox) return (ephemeral ??= randomBytes(32));
  const raw = process.env.MYNT_VAULT_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

export const vaultAvailable = (sandbox: boolean) => keyFor(sandbox) !== null;

// Sandbox data that must outlive a restart (vendors' results queued for an innovator's webhook): a key derived
// from MYNT_VAULT_KEY under its own label, so it never opens live data and live data never opens with it.
function durableSandboxKey(): Buffer | null {
  const live = keyFor(false);
  return live ? Buffer.from(hkdfSync("sha256", live, Buffer.alloc(0), "mynt-sandbox-durable-v1", 32)) : null;
}

// `durable` matters for sandbox only: sealed with the derived key (marked v1s) when MYNT_VAULT_KEY is set.
export function seal(value: string, sandbox: boolean, durable = false): string {
  const derived = sandbox && durable ? durableSandboxKey() : null;
  const key = derived ?? keyFor(sandbox);
  if (!key) throw new Error("vault key not configured");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [derived ? "v1s" : "v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function open(sealed: string, sandbox: boolean): string {
  const [v, iv, tag, ct] = sealed.split(":");
  if (v !== "v1" && !(v === "v1s" && sandbox)) throw new Error("unknown vault format");
  const key = v === "v1s" ? durableSandboxKey() : keyFor(sandbox);
  if (!key) throw new Error("vault key not configured");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
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
