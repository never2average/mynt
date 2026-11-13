// The workspace's compliance pages, read from Mynt: Coverage (which US states the workspace's
// products can serve, and through which partners), Licences (the partner licences behind them)
// and Audits (who did what). Mynt's replies are read defensively: anything missing or malformed
// is left out, never guessed.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((x) => (str(x) ? [str(x)!] : [])) : []);

// ---------- Coverage ----------

export const COVERAGE_STATUSES = ["unlocked", "available", "unavailable"] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];
export const COVERAGE_LABELS: Record<CoverageStatus, string> = {
  unlocked: "Unlocked",
  available: "Available",
  unavailable: "Unavailable",
};
export const COVERAGE_HELP: Record<CoverageStatus, string> = {
  unlocked: "Your products can serve customers here now",
  available: "A partner is licensed here; you haven't unlocked it yet",
  unavailable: "No partner is licensed here yet",
};

export type Partner = { entityId: string | null; name: string };
export type CoverageState = {
  code: string; // two-letter postal code
  name: string;
  status: CoverageStatus;
  partners: Partner[];
  licences: string[];
  products: string[];
  rails: string[];
};
export type Coverage = { states: CoverageState[] };

// A list of names: strings, or objects with a name (or a number, for licences).
function labels(v: unknown, ...keys: string[]): string[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    if (str(x)) return [str(x)!];
    if (!isObj(x)) return [];
    const parts = keys.map((k) => str(x[k])).filter((p): p is string => Boolean(p));
    return parts.length ? [parts.join(" · ")] : [];
  });
}

export function fromCoverage(raw: unknown): Coverage {
  const list = isObj(raw) && Array.isArray(raw.states) ? raw.states : [];
  const states = list.filter(isObj).flatMap((s): CoverageState[] => {
    const code = str(s.code)?.toUpperCase();
    if (!code || !/^[A-Z]{2}$/.test(code)) return [];
    const status = COVERAGE_STATUSES.find((c) => c === s.status) ?? "unavailable";
    const partners = (Array.isArray(s.partners) ? s.partners : []).flatMap((p): Partner[] => {
      if (str(p)) return [{ entityId: null, name: str(p)! }];
      if (isObj(p) && str(p.name)) return [{ entityId: str(p.entity_id), name: str(p.name)! }];
      return [];
    });
    return [
      {
        code,
        name: str(s.name) ?? STATE_NAMES[code] ?? code,
        status,
        partners,
        licences: labels(s.licences, "type", "number"),
        products: labels(s.products, "name"),
        rails: labels(s.rails, "name"),
      },
    ];
  });
  return { states };
}

// Every state and DC, with what Mynt said about it; a state Mynt didn't mention is unavailable.
export function allStates(coverage: Coverage): CoverageState[] {
  const byCode = new Map(coverage.states.map((s) => [s.code, s]));
  return Object.entries(STATE_NAMES).map(
    ([code, name]) => byCode.get(code) ?? { code, name, status: "unavailable", partners: [], licences: [], products: [], rails: [] },
  );
}

export function countByStatus(states: CoverageState[]): Record<CoverageStatus, number> {
  const counts = { unlocked: 0, available: 0, unavailable: 0 };
  for (const s of states) counts[s.status] += 1;
  return counts;
}

// The 50 states and DC by postal code, and the FIPS codes the us-atlas map uses for them.
export const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

export const FIPS_TO_CODE: Record<string, string> = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC",
  "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
  "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT",
  "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
  "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
  "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY",
};

// ---------- Licences ----------

export type Licence = {
  partner: string | null;
  type: string | null;
  regulator: string | null;
  number: string | null;
  states: string[];
  status: string | null;
  expiresAt: string | null; // ISO date
};

export function fromLicences(raw: unknown): Licence[] {
  const list = isObj(raw) && Array.isArray(raw.licences) ? raw.licences : Array.isArray(raw) ? raw : [];
  return list.filter(isObj).map((l) => ({
    partner: str(l.partner) ?? (isObj(l.partner) ? str(l.partner.name) : null),
    type: str(l.type),
    regulator: str(l.regulator),
    number: str(l.number),
    states: strs(l.states).map((s) => s.toUpperCase()),
    status: str(l.status)?.toLowerCase() ?? null,
    expiresAt: str(l.expires_at),
  }));
}

export const EXPIRING_DAYS = 60;
export type Expiry = "expired" | "expiring" | null;

// Whether a licence has expired, or expires within EXPIRING_DAYS.
export function expiryOf(l: Licence, now = Date.now()): Expiry {
  if (l.status === "expired") return "expired";
  const at = l.expiresAt ? Date.parse(l.expiresAt) : NaN;
  if (Number.isNaN(at)) return null;
  if (at <= now) return "expired";
  return at - now <= EXPIRING_DAYS * 86_400_000 ? "expiring" : null;
}

export type LicenceFilters = { query: string; status: string; regulator: string; state: string };
export const NO_LICENCE_FILTERS: LicenceFilters = { query: "", status: "", regulator: "", state: "" };

export function filterLicences(list: Licence[], f: LicenceFilters, now = Date.now()): Licence[] {
  const q = f.query.trim().toLowerCase();
  return list.filter((l) => {
    if (q && ![l.partner, l.type, l.regulator, l.number, ...l.states].some((v) => v?.toLowerCase().includes(q))) return false;
    if (f.status) {
      const e = expiryOf(l, now);
      if (f.status === "expired" || f.status === "expiring" ? e !== f.status : l.status !== f.status) return false;
    }
    if (f.regulator && l.regulator !== f.regulator) return false;
    if (f.state && !l.states.includes(f.state)) return false;
    return true;
  });
}

export const distinct = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => Boolean(v)))].sort();

// ---------- Audits ----------

export type AuditEvent = {
  at: string;
  actor: { id: string | null; name: string | null };
  action: string;
  target: { type: string | null; id: string | null; name: string | null };
  details: string | null;
};
export type AuditPage = { events: AuditEvent[]; nextCursor: string | null };

const detailsText = (v: unknown): string | null => {
  if (str(v)) return str(v);
  if (isObj(v) && Object.keys(v).length) return JSON.stringify(v);
  return null;
};

export function fromAudit(raw: unknown): AuditPage {
  const list = isObj(raw) && Array.isArray(raw.events) ? raw.events : [];
  const events = list.filter(isObj).flatMap((e): AuditEvent[] => {
    const at = str(e.at);
    const action = str(e.action);
    if (!at || !action) return [];
    const actor = isObj(e.actor) ? e.actor : {};
    const target = isObj(e.target) ? e.target : {};
    return [
      {
        at,
        action,
        actor: { id: str(actor.id), name: str(actor.name) },
        target: { type: str(target.type), id: str(target.id), name: str(target.name) },
        details: detailsText(e.details),
      },
    ];
  });
  return { events, nextCursor: isObj(raw) ? str(raw.next_cursor) : null };
}

export const AUDIT_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function searchAudit(events: AuditEvent[], query: string): AuditEvent[] {
  const q = query.trim().toLowerCase();
  if (!q) return events;
  return events.filter((e) => [e.action, e.actor.name, e.target.type, e.target.name, e.details].some((v) => v?.toLowerCase().includes(q)));
}

// ---------- CSV export ----------

export function toCsv(header: string[], rows: (string | null)[][]): string {
  const cell = (v: string | null) => {
    let s = v ?? "";
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // never a formula when opened in a spreadsheet
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\n");
}
