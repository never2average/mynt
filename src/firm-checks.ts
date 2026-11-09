import { createHash } from "node:crypto";
import type { Entity, FirmCheck, FirmCheckStatus, Store } from "./store.js";
import { safeRequest, type VendorCallOptions } from "./vendor-call.js";

// Is a licence provider a real, legitimate company? Mynt asks public registers itself, never trusting what the
// firm says about itself, and records each answer (firm_checks: the source, the URL, when, the fields matched,
// the status and a hash of the answer):
//
//   gleif_lei   GLEIF's LEI record (api.gleif.org, free, no key, CC0 data): the legal name, the registration
//               authority and number, the entity's and the LEI's status, and the jurisdiction, matched against the
//               firm's legal name and incorporation. Needs the firm's LEI (identifier scheme 'lei').
//   fincen_msb  FinCEN's MSB Registrant Search list (msb.fincen.gov's "View/download ... in Excel" export, which
//               FinCEN offers "for the benefit of the financial institutions ... to integrate into their data
//               processing systems"; updated weekly): the registrant's legal name and state. The list carries no
//               registration numbers, so a firm's MSB registration number is shown with a link for an admin to
//               check by hand.
//
// NMLS Consumer Access has no API anyone may use, and its terms forbid downloading what it shows (NMLS's paid
// B2B Access is the sanctioned route), so Mynt never fetches it: a firm's NMLS ID (identifier 'us_nmls') is
// shown with a link for an admin to check by hand, and its state licences stay verified by admins (review_license).
//
// Sponsorship is gated on the result (approve_sponsorship; the rule is SPONSOR_LEGITIMACY_RULE), and a later
// mismatch or lapse drifts the products a firm sponsors, as a licence lapsing does (see pins.ts).

export const FIRM_CHECK_SOURCES = ["gleif_lei", "fincen_msb"] as const;
export type FirmCheckSource = (typeof FIRM_CHECK_SOURCES)[number];

// The rule a licence provider must pass before it may sponsor. Set by SPONSOR_LEGITIMACY_RULE on the server:
//   lei_or_msb  (default) a matching LEI record or a matching FinCEN MSB registration, and no mismatch or lapse
//   lei_and_msb both
//   lei         a matching LEI record, and no mismatch or lapse
//   msb         a matching FinCEN MSB registration, and no mismatch or lapse
//   off         no gate and no drift (staging with the placeholder firm, which isn't a real company)
export const LEGITIMACY_RULES = ["lei_or_msb", "lei_and_msb", "lei", "msb", "off"] as const;
export type LegitimacyRule = (typeof LEGITIMACY_RULES)[number];
export const DEFAULT_LEGITIMACY_RULE: LegitimacyRule = "lei_or_msb";
export function legitimacyRule(): LegitimacyRule {
  const v = process.env.SPONSOR_LEGITIMACY_RULE?.trim();
  return (LEGITIMACY_RULES as readonly string[]).includes(v ?? "") ? (v as LegitimacyRule) : DEFAULT_LEGITIMACY_RULE;
}
const RULE_TEXT: Record<LegitimacyRule, string> = {
  lei_or_msb: "a matching GLEIF LEI record or a matching FinCEN MSB registration, and no mismatch or lapse",
  lei_and_msb: "a matching GLEIF LEI record and a matching FinCEN MSB registration, and no mismatch or lapse",
  lei: "a matching GLEIF LEI record, and no mismatch or lapse",
  msb: "a matching FinCEN MSB registration, and no mismatch or lapse",
  off: "none (the check is off on this server)",
};

// The fixed hosts Mynt asks. Tests point these at fakes on 127.0.0.1; nothing in the server's configuration can.
const SOURCES = {
  gleif: "https://api.gleif.org/api/v1/lei-records/",
  fincen: "https://msb.fincen.gov/retrieve.msb.list.php",
};
export const PUBLIC_PAGES = {
  gleif: (lei: string) => `https://search.gleif.org/#/record/${lei}`,
  fincen: "https://msb.fincen.gov/",
  nmls: (id: string) => `https://www.nmlsconsumeraccess.org/EntityDetails.aspx/COMPANY/${encodeURIComponent(id)}`,
};
let sources = { ...SOURCES };
let outbound: VendorCallOptions = {};
export function setFirmCheckSourcesForTests(s: { gleif?: string; fincen?: string } | null) {
  sources = { ...SOURCES, ...(s ?? {}) };
  outbound = s ? { allowInsecureLoopback: true } : {};
  fincenCache = null;
}
const USER_AGENT = "Mynt-Firm-Checks/1 (+https://github.com/never2average/mynt)";

// A stable JSON form (keys sorted) and its hash, so the same answer always hashes the same.
const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v as object)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v ?? null);
const hashOf = (v: unknown) => "sha256:" + createHash("sha256").update(stable(v)).digest("hex");

// A legal name as registers spell it differently: case, punctuation, "&", and the common suffixes.
const SUFFIXES: [RegExp, string][] = [
  [/\bLIMITED LIABILITY COMPANY\b/g, "LLC"],
  [/\bL L C\b/g, "LLC"],
  [/\bL L P\b/g, "LLP"],
  [/\bL P\b/g, "LP"],
  [/\bINCORPORATED\b/g, "INC"],
  [/\bCORPORATION\b/g, "CORP"],
  [/\bCOMPANY\b/g, "CO"],
  [/\bLIMITED\b/g, "LTD"],
];
export function normalizeName(name: string): string {
  let n = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[.,'’"`]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/^THE /, "");
  for (const [re, to] of SUFFIXES) n = n.replace(re, to);
  return n.replace(/\s+/g, " ").trim();
}

// ISO 17442: 18 characters then two check digits, valid under ISO 7064 MOD 97-10.
export function validLei(lei: string): boolean {
  if (!/^[A-Z0-9]{18}[0-9]{2}$/.test(lei)) return false;
  let rem = 0;
  for (const ch of lei) {
    const d = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of d) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1;
}

export const leiOf = (e: Pick<Entity, "identifiers">) => e.identifiers.find((i) => i.scheme === "lei")?.value.trim().toUpperCase() || null;
const identifier = (e: Pick<Entity, "identifiers">, scheme: string) => e.identifiers.find((i) => i.scheme === scheme)?.value.trim() || null;

type Result = Omit<FirmCheck, "id" | "retrieved_at" | "entity_id" | "run_by">;

// ---- GLEIF ----

// Statuses of an LEI that still identify a live entity; anything else (LAPSED, RETIRED, ANNULLED, MERGED,
// DUPLICATE, TRANSFERRED) is a lapse.
const LEI_IN_FORCE = ["ISSUED", "PENDING_TRANSFER", "PENDING_ARCHIVAL"];

export async function checkGleif(entity: Entity): Promise<Result | null> {
  const lei = leiOf(entity);
  if (!lei) return null;
  const url = `${sources.gleif}${encodeURIComponent(lei)}`;
  const base = { source: "gleif_lei", subject: lei, url };
  if (!validLei(lei)) return { ...base, status: "not_found", fields: { lei }, response_hash: null, note: `'${lei}' isn't a well-formed LEI (ISO 17442)` };
  const r = await safeRequest("GET", url, null, { Accept: "application/vnd.api+json", "User-Agent": USER_AGENT }, { ...outbound, timeoutMs: 15_000 });
  if (r.http_status === 404) return { ...base, status: "not_found", fields: { lei }, response_hash: hashOf({ lei, found: false }), note: "GLEIF has no record of this LEI" };
  if (!r.ok) return { ...base, status: "unavailable", fields: { lei }, response_hash: null, note: `GLEIF didn't answer (${r.error})` };
  const a = (r.body as { data?: { attributes?: GleifAttributes } })?.data?.attributes;
  if (!a?.entity || !a.registration) return { ...base, status: "unavailable", fields: { lei }, response_hash: null, note: "GLEIF's answer wasn't an LEI record" };
  const e = a.entity;
  const fields = {
    lei,
    legal_name: e.legalName?.name ?? null,
    registration_authority: e.registeredAt?.id ?? null,
    registered_as: e.registeredAs ?? null,
    jurisdiction: e.jurisdiction ?? null,
    legal_form: e.legalForm?.id ?? null,
    entity_status: e.status ?? null,
    registration_status: a.registration.status ?? null,
    next_renewal: a.registration.nextRenewalDate ?? null,
    corroboration_level: a.registration.corroborationLevel ?? null,
    legal_address_region: e.legalAddress?.region ?? null,
    headquarters_region: e.headquartersAddress?.region ?? null,
    country: e.legalAddress?.country ?? null,
  };
  const mismatches: string[] = [];
  if (normalizeName(fields.legal_name ?? "") !== normalizeName(entity.name)) mismatches.push(`legal name: GLEIF has '${fields.legal_name}', the firm is '${entity.name}'`);
  const inc = entity.incorporation;
  if (inc && fields.jurisdiction) {
    // GLEIF gives a country ("US") or a subdivision ("US-DE"); compare as far as both go.
    const theirs = fields.jurisdiction.toLowerCase();
    if (theirs.slice(0, 2) !== inc.country || (theirs.includes("-") && inc.subdivision && theirs !== inc.subdivision))
      mismatches.push(`jurisdiction: GLEIF has ${fields.jurisdiction}, the firm is incorporated in ${(inc.subdivision ?? inc.country).toUpperCase()}`);
  }
  if (fields.entity_status !== "ACTIVE") mismatches.push(`entity status: GLEIF has ${fields.entity_status}, not ACTIVE`);
  if (!LEI_IN_FORCE.includes(fields.registration_status ?? "")) mismatches.push(`LEI status: ${fields.registration_status} (lapsed: not ${LEI_IN_FORCE.join(", ")})`);
  return { ...base, status: mismatches.length ? "mismatch" : "match", fields: { ...fields, mismatches }, response_hash: hashOf(a), note: mismatches.length ? mismatches.join("; ") : null };
}

interface GleifAttributes {
  entity?: {
    legalName?: { name?: string };
    registeredAt?: { id?: string };
    registeredAs?: string;
    jurisdiction?: string;
    legalForm?: { id?: string };
    status?: string;
    legalAddress?: { region?: string; country?: string };
    headquartersAddress?: { region?: string };
  };
  registration?: { status?: string; nextRenewalDate?: string; corroborationLevel?: string };
}

// ---- FinCEN's MSB registrant list ----

const MSB_COLUMNS = [
  "LEGAL NAME",
  "DBA NAME",
  "STREET ADDRESS",
  "CITY",
  "STATE",
  "ZIP",
  "MSB ACTIVITIES",
  "STATES OF MSB ACTIVITIES",
  "ALL STATES & TERRITORIES & FOREIGN FLAG**",
  "FOREIGN LOCATION",
  "# OF BRANCHES",
  "AUTH SIGN DATE",
  "RECEIVED DATE",
];
export interface MsbRow {
  legal_name: string;
  dba_name: string;
  city: string;
  state: string;
  msb_activities: string;
  states_of_activity: string;
  auth_sign_date: string;
  received_date: string;
  line: string;
}

// The export is tab-separated text: a header row, one row per registrant, then a key to the codes.
export function parseMsbList(text: string): MsbRow[] | string {
  const lines = text.split(/\r?\n/);
  const header = lines[0]?.split("\t").map((c) => c.trim());
  if (!header || MSB_COLUMNS.some((c, i) => header[i] !== c)) return "FinCEN's list isn't in the format Mynt reads (its columns changed)";
  const rows: MsbRow[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split("\t");
    if (c.length !== MSB_COLUMNS.length || !c[0].trim()) continue;
    rows.push({
      legal_name: c[0].trim(),
      dba_name: c[1].trim(),
      city: c[3].trim(),
      state: c[4].trim().toUpperCase(),
      msb_activities: c[6].trim(),
      states_of_activity: c[7].trim(),
      auth_sign_date: c[11].trim(),
      received_date: c[12].trim(),
      line: line.trim(),
    });
  }
  return rows.length ? rows : "FinCEN's list came back empty";
}

// One download serves every firm checked for six hours (it's a few megabytes, updated weekly).
let fincenCache: { at: number; rows: MsbRow[] } | null = null;
async function fincenList(): Promise<{ rows: MsbRow[] } | { error: string }> {
  if (fincenCache && Date.now() - fincenCache.at < 6 * 60 * 60 * 1000) return fincenCache;
  const r = await safeRequest(
    "POST",
    sources.fincen,
    "site=AA",
    { "Content-Type": "application/x-www-form-urlencoded", Accept: "*/*", "User-Agent": USER_AGENT },
    { ...outbound, rawBody: true, timeoutMs: 120_000, maxResponseBytes: 64 * 1024 * 1024 },
  );
  if (!r.ok || typeof r.body !== "string") return { error: `FinCEN didn't answer (${r.error})` };
  const rows = parseMsbList(r.body);
  if (typeof rows === "string") return { error: rows };
  fincenCache = { at: Date.now(), rows };
  return fincenCache;
}

// The firm's FinCEN MSB registration number, as it states it (an identifier, or its registered FinCEN licence).
async function msbNumber(store: Store, entity: Entity) {
  return identifier(entity, "us_fincen_msb") ?? (await store.licensesOf(entity.id)).find((l) => l.regulator_id === "fincen")?.registration_number ?? null;
}

// addressStates: the US states GLEIF records the firm's legal and head-office addresses in, when its LEI matched
// (FinCEN's list gives the registrant's address state, not where it's incorporated).
export async function checkFincen(store: Store, entity: Entity, addressStates: string[] = []): Promise<Result> {
  const subject = normalizeName(entity.name);
  const regNo = await msbNumber(store, entity);
  const manual = { registration_number: regNo, registration_number_checked: false, check_registration_number_at: PUBLIC_PAGES.fincen };
  const base = { source: "fincen_msb", subject, url: PUBLIC_PAGES.fincen };
  const list = await fincenList();
  if ("error" in list) return { ...base, status: "unavailable", fields: manual, response_hash: null, note: list.error };
  const candidates = list.rows.filter((r) => normalizeName(r.legal_name) === subject);
  const hash = hashOf({ subject, rows: candidates.map((c) => c.line).sort() });
  if (!candidates.length) return { ...base, status: "not_found", fields: manual, response_hash: hash, note: `No current MSB registrant is named '${entity.name}'` };
  const describe = (c: MsbRow) => ({ legal_name: c.legal_name, dba_name: c.dba_name || null, city: c.city, state: c.state, msb_activities: c.msb_activities, states_of_activity: c.states_of_activity, auth_sign_date: c.auth_sign_date, received_date: c.received_date });
  const latest = (cs: MsbRow[]) => [...cs].sort((a, b) => Date.parse(b.received_date) - Date.parse(a.received_date))[0];
  const states = new Set(addressStates.map((s) => s.toUpperCase()));
  if (states.size) {
    const inState = candidates.filter((c) => states.has(c.state));
    if (inState.length) return { ...base, status: "match", fields: { ...describe(latest(inState)), state_compared_with: [...states], ...manual }, response_hash: hash, note: null };
    return {
      ...base,
      status: "mismatch",
      fields: { ...describe(latest(candidates)), state_compared_with: [...states], registrant_states: [...new Set(candidates.map((c) => c.state))], ...manual },
      response_hash: hash,
      note: `FinCEN's registrant '${entity.name}' is in ${[...new Set(candidates.map((c) => c.state))].join(", ")}, not ${[...states].join(" or ")} where GLEIF records the firm`,
    };
  }
  if (candidates.length === 1) return { ...base, status: "match", fields: { ...describe(candidates[0]), state_compared_with: null, ...manual }, response_hash: hash, note: "Matched by legal name; the state wasn't compared (no LEI record gives the firm's address)" };
  return {
    ...base,
    status: "not_found",
    fields: { registrant_states: [...new Set(candidates.map((c) => c.state))], ...manual },
    response_hash: hash,
    note: `${candidates.length} MSB registrants share the name '${entity.name}'; record the firm's LEI so its address can tell them apart`,
  };
}

// ---- running them ----

export async function runFirmChecks(store: Store, entityId: string, runBy: string | null): Promise<FirmCheck[]> {
  const entity = await store.getEntity(entityId);
  if (!entity) throw new Error(`No firm '${entityId}'`);
  const out: FirmCheck[] = [];
  const gleif = await checkGleif(entity);
  if (gleif) out.push(await store.recordFirmCheck({ ...gleif, entity_id: entity.id, run_by: runBy }));
  const usState = (r: unknown) => (typeof r === "string" && /^US-[A-Z]{2}$/.test(r) ? r.slice(3) : null);
  const addressStates =
    gleif?.status === "match" ? [usState(gleif.fields.legal_address_region), usState(gleif.fields.headquarters_region)].filter((s): s is string => Boolean(s)) : [];
  out.push(await store.recordFirmCheck({ ...(await checkFincen(store, entity, addressStates)), entity_id: entity.id, run_by: runBy }));
  return out;
}

// ---- the verdict ----

export interface Legitimacy {
  rule: LegitimacyRule;
  rule_text: string;
  passes: boolean;
  reasons: string[]; // why it doesn't pass
  flags: string[]; // mismatches and lapses: these drift sponsored products
  checks: Record<FirmCheckSource, { subject: string | null; status: FirmCheckStatus | "not_run"; lapsed: boolean; latest: FirmCheck | null; last_result: FirmCheck | null }>;
  verify_by_hand: { what: string; value: string | null; url: string; why: string }[];
  last_run_at: string | null;
}

export async function firmLegitimacy(store: Store, entityId: string): Promise<Legitimacy | null> {
  const entity = await store.getEntity(entityId);
  if (!entity) return null;
  const rule = legitimacyRule();
  const history = await store.firmChecks(entityId);
  const subjects: Record<FirmCheckSource, string | null> = { gleif_lei: leiOf(entity), fincen_msb: normalizeName(entity.name) };
  const checks = {} as Legitimacy["checks"];
  const flags: string[] = [];
  for (const source of FIRM_CHECK_SOURCES) {
    const subject = subjects[source];
    const rows = subject ? history.filter((c) => c.source === source && c.subject === subject) : [];
    // The latest answer that says something (an outage keeps the last one).
    const result = rows.find((c) => c.status !== "unavailable") ?? null;
    const lapsed = result?.status === "not_found" && rows.some((c) => c.status === "match");
    if (result?.status === "mismatch") flags.push(`${source}:mismatch`);
    if (lapsed) flags.push(`${source}:lapsed`);
    checks[source] = { subject, status: result?.status ?? rows[0]?.status ?? "not_run", lapsed, latest: rows[0] ?? null, last_result: result };
  }
  const lei = checks.gleif_lei.last_result?.status === "match";
  const msb = checks.fincen_msb.last_result?.status === "match";
  const reasons: string[] = [];
  if (rule !== "off") {
    const need = { lei_or_msb: lei || msb, lei_and_msb: lei && msb, lei, msb }[rule];
    if (!need) {
      if (!subjects.gleif_lei && rule !== "msb") reasons.push("The firm has no LEI on record (set_entity_facts identifiers: { scheme: 'lei', value })");
      for (const s of FIRM_CHECK_SOURCES) {
        const c = checks[s];
        if (c.status === "match" || (s === "gleif_lei" && !subjects.gleif_lei)) continue;
        if (c.status === "not_run") reasons.push(`${s}: not checked yet (an admin runs run_firm_checks)`);
        else reasons.push(`${s}: ${c.status}${c.last_result?.note ? ` (${c.last_result.note})` : c.latest?.note ? ` (${c.latest.note})` : ""}`);
      }
    }
    for (const f of flags) reasons.push(`${f.replace(":", " ")}: ${checks[f.split(":")[0] as FirmCheckSource].last_result?.note ?? "it no longer matches"}`);
  }
  const verify_by_hand: Legitimacy["verify_by_hand"] = [];
  const nmls = identifier(entity, "us_nmls");
  if (nmls)
    verify_by_hand.push({
      what: "NMLS ID",
      value: nmls,
      url: PUBLIC_PAGES.nmls(nmls),
      why: "NMLS Consumer Access allows no automated access, so an admin checks it there; its state licences are verified as any licence (review_license)",
    });
  const regNo = await msbNumber(store, entity);
  if (regNo)
    verify_by_hand.push({
      what: "FinCEN MSB registration number",
      value: regNo,
      url: PUBLIC_PAGES.fincen,
      why: "FinCEN's downloadable list carries no registration numbers; search the number there",
    });
  return {
    rule,
    rule_text: RULE_TEXT[rule],
    passes: rule === "off" || reasons.length === 0,
    reasons,
    flags: rule === "off" ? [] : flags,
    checks,
    verify_by_hand,
    last_run_at: history[0]?.retrieved_at ?? null,
  };
}

// A short form for lists (sponsorship requests, firms).
export const legitimacySummary = (l: Legitimacy | null) =>
  l && {
    rule: l.rule,
    passes: l.passes,
    reasons: l.reasons,
    flags: l.flags,
    checks: Object.fromEntries(
      Object.entries(l.checks).map(([k, c]) => [k, { subject: c.subject, status: c.status, lapsed: c.lapsed, retrieved_at: c.last_result?.retrieved_at ?? c.latest?.retrieved_at ?? null, url: c.last_result?.url ?? c.latest?.url ?? null, note: c.last_result?.note ?? c.latest?.note ?? null }]),
    ),
    verify_by_hand: l.verify_by_hand,
    last_run_at: l.last_run_at,
  };

// What a product sponsored by this firm pins: "clear", or the mismatches and lapses that drift it.
export async function legitimacyState(store: Store, entityId: string): Promise<string> {
  const l = await firmLegitimacy(store, entityId);
  return !l || !l.flags.length ? "clear" : `flagged:${[...l.flags].sort().join(",")}`;
}
