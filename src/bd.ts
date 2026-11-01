import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AgentMeter } from "./agent-meter.js";
import type { AgentRun } from "./agent-proxy.js";
import { serialLoop } from "./worker.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { agentState, launchAgent, type AgentHostConfig } from "./agent-host.js";
import type { BoatClient } from "./boat.js";
import type { Db } from "./db.js";
import type { User } from "./store.js";

// Business development: Mynt's connector agent finds innovators (licensed firms that bring products)
// and developers (who build on them), talks with them, and introduces them to each other. It runs
// autonomously on the same Claude Code harness as builds, with Mynt's MCP server as its only hands.
// Everything it may do to a person goes through send(), which enforces the rules in code: who may be
// contacted first and on which channel, consent and opt-outs, caps, follow-up limits and quiet hours.
// Prospect data lives only in Mynt's database.

export const BD_CHANNELS = ["email", "whatsapp", "phone"] as const;
export type BdChannel = (typeof BD_CHANNELS)[number];
// none: nothing known; public_business: published by them or their firm for business contact (cold
// email only); referred: someone who knows them pointed us to them (cold email only); opted_in: they
// asked to be contacted on this channel; opted_out: never again.
export const CONSENTS = ["none", "public_business", "referred", "opted_in", "opted_out"] as const;
export type Consent = (typeof CONSENTS)[number];
// What a person can consent to, separately. Every grant or withdrawal is a row in an append-only ledger.
export const PURPOSES = ["contact_email", "contact_whatsapp", "contact_phone", "introductions", "profile"] as const;
export type Purpose = (typeof PURPOSES)[number];
// Why Mynt may hold or use it: they asked (consent), their business contact is published, a referral, or the
// profile was built from information they made publicly available.
export type Basis = "consent" | "public_business" | "referral" | "publicly_available";
const contactPurpose = (c: BdChannel) => `contact_${c}` as Purpose;
const basisOf = (c: Consent): Basis => (c === "opted_in" ? "consent" : c === "referred" ? "referral" : "public_business");

export const STAGES = ["sourced", "contacted", "engaged", "interested", "onboarded", "declined", "suppressed"] as const;
export const SOURCES = ["regulator_register", "company_site", "github", "apollo", "referral", "inbound", "event", "import"] as const;

export interface BdConfig extends AgentHostConfig {
  enabled: boolean; // BD_ENABLED=1; admins can still pause it
  dailyCap: number; // outbound messages per day, all channels
  maxUnansweredTouches: number; // per prospect, before they ever reply
  followUpGapDays: number;
  runCapUsd: number;
  monthlyCapUsd: number;
  everyHours: number;
  sandboxType: string;
  senderName: string;
  profileRetentionDays: number; // public-source profiles of people who never replied are erased after this
}

export function bdConfigFromEnv(host: AgentHostConfig, env = process.env): BdConfig {
  return {
    ...host,
    enabled: env.BD_ENABLED === "1",
    dailyCap: Number(env.BD_DAILY_CAP ?? 40),
    maxUnansweredTouches: Number(env.BD_MAX_UNANSWERED ?? 3),
    followUpGapDays: Number(env.BD_FOLLOW_UP_GAP_DAYS ?? 3),
    runCapUsd: Number(env.BD_RUN_CAP_USD ?? 3),
    monthlyCapUsd: Number(env.BD_MONTHLY_CAP_USD ?? 60),
    everyHours: Number(env.BD_RUN_EVERY_HOURS ?? 6),
    sandboxType: env.BUILD_SANDBOX_TYPE ?? "default",
    senderName: env.BD_SENDER_NAME ?? "Mynt connector",
    profileRetentionDays: Number(env.BD_PROFILE_RETENTION_DAYS ?? 180),
  };
}

// A way to reach people on one channel. Email, WhatsApp and voice providers plug in here.
export interface ChannelSender {
  send(m: { to: string; subject?: string; text: string; headers: Record<string, string> }): Promise<{ id: string }>;
}

const TABLES = `
  CREATE TABLE IF NOT EXISTS financial_products.bd_prospects (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('innovator', 'developer')),
    name text NOT NULL,
    org text,
    title text,
    region text NOT NULL DEFAULT 'IN',
    source text NOT NULL,
    source_url text,
    profile jsonb NOT NULL DEFAULT '{}',
    notes text NOT NULL DEFAULT '',
    stage text NOT NULL DEFAULT 'sourced',
    user_id uuid REFERENCES financial_products.users(id),
    next_action_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS bd_prospects_stage_idx ON financial_products.bd_prospects (stage, updated_at DESC);
  CREATE TABLE IF NOT EXISTS financial_products.bd_contacts (
    id uuid PRIMARY KEY,
    prospect_id uuid NOT NULL REFERENCES financial_products.bd_prospects(id),
    channel text NOT NULL,
    address text NOT NULL,
    address_hash text NOT NULL,
    consent text NOT NULL,
    consent_source text NOT NULL DEFAULT '',
    consent_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (channel, address_hash)
  );
  -- Opted-out addresses, kept as hashes so they stay suppressed even after a prospect is removed.
  CREATE TABLE IF NOT EXISTS financial_products.bd_suppressions (
    address_hash text PRIMARY KEY,
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS financial_products.bd_messages (
    id uuid PRIMARY KEY,
    prospect_id uuid NOT NULL REFERENCES financial_products.bd_prospects(id),
    contact_id uuid REFERENCES financial_products.bd_contacts(id),
    channel text NOT NULL,
    direction text NOT NULL CHECK (direction IN ('out', 'in')),
    subject text,
    body text NOT NULL,
    status text NOT NULL,
    provider_id text,
    run_id uuid,
    handled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS bd_messages_prospect_idx ON financial_products.bd_messages (prospect_id, created_at);
  CREATE TABLE IF NOT EXISTS financial_products.bd_intros (
    id uuid PRIMARY KEY,
    a uuid NOT NULL REFERENCES financial_products.bd_prospects(id),
    b uuid NOT NULL REFERENCES financial_products.bd_prospects(id),
    reason text NOT NULL,
    a_yes boolean,
    b_yes boolean,
    status text NOT NULL DEFAULT 'proposed',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS financial_products.bd_runs (
    id uuid PRIMARY KEY,
    status text NOT NULL,
    sandbox_id text,
    process_id text,
    token_hash text,
    cost_usd numeric NOT NULL DEFAULT 0,
    cap_usd numeric NOT NULL,
    summary text,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
  );
  CREATE TABLE IF NOT EXISTS financial_products.bd_consents (
    id uuid PRIMARY KEY,
    prospect_id uuid NOT NULL REFERENCES financial_products.bd_prospects(id) ON DELETE CASCADE,
    purpose text NOT NULL,
    granted boolean NOT NULL,
    basis text NOT NULL,
    evidence text NOT NULL,
    actor text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS bd_consents_prospect_idx ON financial_products.bd_consents (prospect_id, purpose, created_at DESC);
  -- Erasures keep no personal data: only the hashes that stay suppressed, and why.
  CREATE TABLE IF NOT EXISTS financial_products.bd_erasures (
    id uuid PRIMARY KEY,
    address_hashes text[] NOT NULL,
    suppressed boolean NOT NULL,
    reason text NOT NULL,
    requested_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE financial_products.bd_prospects ADD COLUMN IF NOT EXISTS legal_basis text;
  ALTER TABLE financial_products.bd_prospects ADD COLUMN IF NOT EXISTS retain_until timestamptz;
  CREATE TABLE IF NOT EXISTS financial_products.bd_settings (
    key text PRIMARY KEY,
    value jsonb NOT NULL
  );
`;

const RUN_DONE = ["finished", "failed", "stopped"];
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const normalize = (channel: string, address: string) =>
  channel === "email" ? address.trim().toLowerCase() : address.replace(/[^\d+]/g, "");
const TIMEZONES: Record<string, string> = { IN: "Asia/Kolkata", US: "America/New_York", GB: "Europe/London", SG: "Asia/Singapore", AE: "Asia/Dubai" };

// Working hours where the person is: weekdays, 09:00 to 19:00.
export function withinWorkingHours(region: string, at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONES[region] ?? "UTC", weekday: "short", hour: "numeric", hour12: false }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const day = parts.find((p) => p.type === "weekday")?.value;
  return day !== "Sat" && day !== "Sun" && hour >= 9 && hour < 19;
}

type Row = Record<string, unknown>;

export class BdService {
  private timer: NodeJS.Timeout | null = null;
  private secret: Buffer | null = null;

  private constructor(
    private readonly db: Db,
    readonly boat: BoatClient | null,
    readonly config: BdConfig,
    private readonly senders: Partial<Record<BdChannel, ChannelSender>>,
    private readonly now: () => Date,
  ) {}

  static async open(db: Db, boat: BoatClient | null, config: BdConfig, senders: Partial<Record<BdChannel, ChannelSender>> = {}, now = () => new Date()) {
    await db.exec(TABLES);
    return new BdService(db, boat, config, senders, now);
  }

  // The agent needs a sandbox host, a model backend and a public URL; admins can pause it any time.
  get runnable() {
    return this.config.enabled && !!this.boat && !!this.config.agentBackend && !!this.config.publicUrl;
  }

  channels() {
    return Object.fromEntries(BD_CHANNELS.map((c) => [c, !!this.senders[c]]));
  }

  private async all(sql: string, params: unknown[] = []) {
    return (await this.db.query(sql, params)).rows as Row[];
  }

  private async one(sql: string, params: unknown[] = []) {
    return (await this.all(sql, params))[0];
  }

  async setting<T>(key: string): Promise<T | null> {
    return ((await this.one("SELECT value FROM financial_products.bd_settings WHERE key = $1", [key]))?.value as T) ?? null;
  }

  async setSetting(key: string, value: unknown) {
    await this.db.query(
      "INSERT INTO financial_products.bd_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [key, JSON.stringify(value)],
    );
  }

  async paused() {
    return (await this.setting<{ paused: boolean }>("pause"))?.paused ?? false;
  }

  // ---- unsubscribe links ----

  private async key() {
    if (this.secret) return this.secret;
    let s = await this.setting<string>("secret");
    if (!s) {
      await this.db.query("INSERT INTO financial_products.bd_settings (key, value) VALUES ('secret', $1) ON CONFLICT DO NOTHING", [JSON.stringify(randomBytes(32).toString("hex"))]);
      s = (await this.setting<string>("secret"))!;
    }
    this.secret = Buffer.from(s, "hex");
    return this.secret;
  }

  async unsubscribeUrl(contactId: string) {
    const sig = createHmac("sha256", await this.key()).update(contactId).digest("base64url");
    return `${this.config.publicUrl}/bd/unsubscribe?c=${contactId}&s=${sig}`;
  }

  async unsubscribe(contactId: string, sig: string) {
    const expected = createHmac("sha256", await this.key()).update(contactId).digest();
    const given = Buffer.from(sig, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    const c = await this.one("SELECT prospect_id FROM financial_products.bd_contacts WHERE id::text = $1", [contactId]);
    if (!c) return false;
    await this.optOut(c.prospect_id as string, "unsubscribe link");
    return true;
  }

  // ---- prospects ----

  async suppressed(channel: string, address: string) {
    return !!(await this.one("SELECT 1 FROM financial_products.bd_suppressions WHERE address_hash = $1", [hash(normalize(channel, address))]));
  }

  async suppress(channel: string, address: string, reason: string) {
    const h = hash(normalize(channel, address));
    await this.db.query("INSERT INTO financial_products.bd_suppressions (address_hash, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING", [h, reason]);
    await this.db.query("UPDATE financial_products.bd_contacts SET consent = 'opted_out', consent_source = $2, consent_at = now() WHERE address_hash = $1", [h, reason]);
  }

  // Opts the person out on every channel, now and for good.
  async optOut(prospectId: string, reason: string) {
    for (const c of await this.all("SELECT channel, address FROM financial_products.bd_contacts WHERE prospect_id = $1", [prospectId])) {
      await this.suppress(c.channel as string, c.address as string, reason);
    }
    for (const purpose of PURPOSES.filter((x) => x !== "profile")) await this.ledger(prospectId, purpose, false, "consent", reason, "system");
    await this.db.query("UPDATE financial_products.bd_prospects SET stage = 'suppressed', updated_at = now() WHERE id = $1", [prospectId]);
  }

  // ---- the consent ledger ----

  async ledger(prospectId: string, purpose: Purpose, granted: boolean, basis: Basis, evidence: string, actor: string) {
    await this.db.query(
      "INSERT INTO financial_products.bd_consents (id, prospect_id, purpose, granted, basis, evidence, actor, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [randomUUID(), prospectId, purpose, granted, basis, evidence.slice(0, 500), actor, this.now().toISOString()],
    );
  }

  // The current state per purpose: the latest ledger row for each.
  async consents(prospectId: string) {
    const rows = await this.all(
      `SELECT DISTINCT ON (purpose) purpose, granted, basis, evidence, actor, created_at FROM financial_products.bd_consents
       WHERE prospect_id::text = $1 ORDER BY purpose, created_at DESC, id`,
      [prospectId],
    );
    return Object.fromEntries(rows.map((r) => [r.purpose as string, { granted: r.granted, basis: r.basis, evidence: r.evidence, at: r.created_at }]));
  }

  // Whether the connector may do `purpose` with this person now, and on what basis.
  async checkConsent(prospectId: string, purpose: Purpose): Promise<{ allowed: boolean; basis: Basis | null; reason: string }> {
    const p = await this.one("SELECT stage FROM financial_products.bd_prospects WHERE id::text = $1", [prospectId]);
    if (!p) return { allowed: false, basis: null, reason: "No such prospect" };
    const state = (await this.consents(prospectId))[purpose] as { granted: boolean; basis: Basis } | undefined;
    if (p.stage === "suppressed") return { allowed: false, basis: null, reason: "They opted out of all contact" };
    if (!state) return { allowed: false, basis: null, reason: purpose === "introductions" ? "Ask them before proposing an introduction" : "No basis recorded for this" };
    if (!state.granted) return { allowed: false, basis: state.basis, reason: "They withdrew it" };
    if ((purpose === "contact_whatsapp" || purpose === "contact_phone") && state.basis !== "consent") {
      return { allowed: false, basis: state.basis, reason: "WhatsApp and calls need their opt-in; offer it by email" };
    }
    return { allowed: true, basis: state.basis, reason: state.basis === "consent" ? "They agreed" : `Basis: ${state.basis}` };
  }

  // Erases a person's connector data: messages, introductions, contacts, consents and profile. With
  // `suppress` (a person's request) their addresses stay suppressed; only hashes and the reason remain.
  async erase(prospectId: string, reason: string, requestedBy: string, opts: { suppress: boolean } = { suppress: true }) {
    const contacts = await this.all("SELECT channel, address, address_hash FROM financial_products.bd_contacts WHERE prospect_id::text = $1", [prospectId]);
    const p = await this.one("SELECT id FROM financial_products.bd_prospects WHERE id::text = $1", [prospectId]);
    if (!p) return false;
    if (opts.suppress) for (const c of contacts) await this.suppress(c.channel as string, c.address as string, reason);
    await this.db.query(
      "INSERT INTO financial_products.bd_erasures (id, address_hashes, suppressed, reason, requested_by) VALUES ($1, $2, $3, $4, $5)",
      [randomUUID(), opts.suppress ? contacts.map((c) => c.address_hash as string) : [], opts.suppress, reason, requestedBy],
    );
    await this.db.query("DELETE FROM financial_products.bd_messages WHERE prospect_id = $1", [p.id]);
    await this.db.query("DELETE FROM financial_products.bd_intros WHERE a = $1 OR b = $1", [p.id]);
    await this.db.query("DELETE FROM financial_products.bd_contacts WHERE prospect_id = $1", [p.id]);
    await this.db.query("DELETE FROM financial_products.bd_prospects WHERE id = $1", [p.id]);
    return true;
  }

  // Public-source profiles of people who never replied aren't kept forever.
  async sweepRetention() {
    const due = await this.all(
      `SELECT id FROM financial_products.bd_prospects p WHERE p.retain_until IS NOT NULL AND p.retain_until < $1 AND p.user_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM financial_products.bd_messages m WHERE m.prospect_id = p.id AND m.direction = 'in')`,
      [this.now().toISOString()],
    );
    for (const r of due) await this.erase(r.id as string, "retention period ended", "system", { suppress: false });
    return due.length;
  }

  async addProspect(p: {
    kind: "innovator" | "developer";
    name: string;
    org?: string;
    title?: string;
    region?: string;
    source: string;
    source_url?: string;
    profile?: Record<string, unknown>;
    notes?: string;
    user_id?: string | null;
    contacts: { channel: BdChannel; address: string; consent: Consent; consent_source?: string }[];
  }): Promise<{ id: string; existing: boolean }> {
    for (const c of p.contacts) {
      if (await this.suppressed(c.channel, c.address)) throw new Error(`${c.channel} ${c.address} has opted out of contact from Mynt`);
    }
    const hashes = p.contacts.map((c) => hash(normalize(c.channel, c.address)));
    const found = hashes.length
      ? await this.one("SELECT prospect_id FROM financial_products.bd_contacts WHERE address_hash = ANY($1) LIMIT 1", [hashes])
      : p.user_id
        ? await this.one("SELECT id AS prospect_id FROM financial_products.bd_prospects WHERE user_id = $1", [p.user_id])
        : undefined;
    const id = (found?.prospect_id as string) ?? randomUUID();
    if (!found) {
      await this.db.query(
        `INSERT INTO financial_products.bd_prospects (id, kind, name, org, title, region, source, source_url, profile, notes, user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, p.kind, p.name, p.org ?? null, p.title ?? null, p.region ?? "IN", p.source, p.source_url ?? null, JSON.stringify(p.profile ?? {}), p.notes ?? "", p.user_id ?? null],
      );
    } else if (p.user_id) {
      await this.db.query("UPDATE financial_products.bd_prospects SET user_id = $2, updated_at = now() WHERE id = $1", [id, p.user_id]);
    }
    for (const c of p.contacts) {
      await this.upsertContact(id, c.channel, c.address, c.consent, c.consent_source ?? p.source_url ?? p.source);
      if (c.consent !== "none") await this.ledger(id, contactPurpose(c.channel), true, basisOf(c.consent), c.consent_source ?? p.source_url ?? p.source, p.user_id ? `user ${p.user_id}` : "connector");
    }
    if (!found) {
      // Why Mynt holds this profile: their own request, a referral, or information they made public (kept for a limited time).
      const basis: Basis = p.source === "inbound" ? "consent" : p.source === "referral" ? "referral" : "publicly_available";
      const until = basis === "consent" ? null : new Date(this.now().getTime() + this.config.profileRetentionDays * 86400e3).toISOString();
      await this.db.query("UPDATE financial_products.bd_prospects SET legal_basis = $2, retain_until = $3 WHERE id = $1", [id, basis, until]);
      await this.ledger(id, "profile", true, basis, p.source_url ?? p.source, p.user_id ? `user ${p.user_id}` : "connector");
    }
    return { id, existing: !!found };
  }

  // A stronger consent replaces a weaker one; an opt-out is never overwritten.
  private async upsertContact(prospectId: string, channel: BdChannel, address: string, consent: Consent, source: string) {
    const normalized = normalize(channel, address);
    await this.db.query(
      `INSERT INTO financial_products.bd_contacts (id, prospect_id, channel, address, address_hash, consent, consent_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (channel, address_hash) DO UPDATE SET consent = EXCLUDED.consent, consent_source = EXCLUDED.consent_source, consent_at = now()
       WHERE bd_contacts.consent <> 'opted_out' AND (EXCLUDED.consent = 'opted_in' OR bd_contacts.consent IN ('none', 'public_business'))`,
      [randomUUID(), prospectId, channel, normalized, hash(normalized), consent, source],
    );
  }

  async prospect(id: string) {
    const p = await this.one("SELECT * FROM financial_products.bd_prospects WHERE id::text = $1", [id]);
    if (!p) return null;
    const [contacts, messages, intros] = await Promise.all([
      this.all("SELECT id, channel, address, consent, consent_source, consent_at FROM financial_products.bd_contacts WHERE prospect_id = $1", [id]),
      this.all("SELECT id, channel, direction, subject, body, status, created_at FROM financial_products.bd_messages WHERE prospect_id = $1 ORDER BY created_at", [id]),
      this.all("SELECT * FROM financial_products.bd_intros WHERE a = $1 OR b = $1 ORDER BY created_at", [id]),
    ]);
    const consents = await this.all("SELECT purpose, granted, basis, evidence, actor, created_at FROM financial_products.bd_consents WHERE prospect_id = $1 ORDER BY created_at", [id]);
    return { ...(p as Row), contacts, messages, intros, consents } as Row & { contacts: Row[]; messages: Row[]; intros: Row[]; consents: Row[] };
  }

  async prospectForUser(userId: string) {
    return this.one("SELECT * FROM financial_products.bd_prospects WHERE user_id = $1", [userId]);
  }

  async search(q: { stage?: string; kind?: string; text?: string; due?: boolean; limit?: number }) {
    return this.all(
      `SELECT id, kind, name, org, title, region, stage, source, next_action_at, updated_at FROM financial_products.bd_prospects
       WHERE ($1::text IS NULL OR stage = $1) AND ($2::text IS NULL OR kind = $2)
         AND ($3::text IS NULL OR name ILIKE '%' || $3 || '%' OR org ILIKE '%' || $3 || '%' OR profile::text ILIKE '%' || $3 || '%')
         AND (NOT $4 OR (next_action_at IS NOT NULL AND next_action_at <= now()))
       ORDER BY updated_at DESC LIMIT $5`,
      [q.stage ?? null, q.kind ?? null, q.text ?? null, q.due ?? false, Math.min(q.limit ?? 50, 200)],
    );
  }

  async updateProspect(id: string, u: { stage?: string; profile?: Record<string, unknown>; notes?: string; next_action_at?: string | null }) {
    await this.db.query(
      `UPDATE financial_products.bd_prospects SET
         stage = CASE WHEN stage = 'suppressed' THEN stage ELSE COALESCE($2, stage) END,
         profile = profile || COALESCE($3::jsonb, '{}'::jsonb),
         notes = COALESCE($4, notes),
         next_action_at = CASE WHEN $5 THEN $6::timestamptz ELSE next_action_at END,
         updated_at = now()
       WHERE id::text = $1`,
      [id, u.stage ?? null, u.profile ? JSON.stringify(u.profile) : null, u.notes ?? null, u.next_action_at !== undefined, u.next_action_at ?? null],
    );
  }

  async recordConsent(prospectId: string, channel: BdChannel, address: string | undefined, consent: "opted_in" | "opted_out", evidence: string) {
    if (consent === "opted_out") return this.optOut(prospectId, evidence);
    const contact = address
      ? { channel, address }
      : ((await this.one("SELECT channel, address FROM financial_products.bd_contacts WHERE prospect_id = $1 AND channel = $2", [prospectId, channel])) as { channel: BdChannel; address: string } | undefined);
    if (!contact) throw new Error(`No ${channel} contact for this prospect; pass the address they gave`);
    if (await this.suppressed(channel, contact.address)) throw new Error("That address has opted out");
    const owner = await this.one("SELECT prospect_id FROM financial_products.bd_contacts WHERE address_hash = $1", [hash(normalize(channel, contact.address))]);
    if (owner && owner.prospect_id !== prospectId) throw new Error("That address belongs to someone else in the pipeline");
    await this.upsertContact(prospectId, channel, contact.address, "opted_in", evidence);
    await this.ledger(prospectId, contactPurpose(channel), true, "consent", evidence, "connector");
  }

  // ---- messages: the one way to reach a person ----

  async send(prospectId: string, channel: BdChannel, m: { subject?: string; body: string }, runId: string | null = null) {
    const p = await this.one("SELECT * FROM financial_products.bd_prospects WHERE id::text = $1", [prospectId]);
    if (!p) throw new Error("No such prospect");
    if (await this.paused()) throw new Error("Outreach is paused by an admin");
    if (p.stage === "suppressed" || p.stage === "declined") throw new Error(`${p.name} has ${p.stage === "declined" ? "declined" : "opted out"}; don't contact them again`);
    const contact = await this.one("SELECT * FROM financial_products.bd_contacts WHERE prospect_id = $1 AND channel = $2 ORDER BY consent_at DESC LIMIT 1", [p.id, channel]);
    if (!contact) throw new Error(`No ${channel} contact for ${p.name}`);
    if (contact.consent === "opted_out" || (await this.suppressed(channel, contact.address as string))) throw new Error(`${p.name} opted out of ${channel}`);
    // Email may open a conversation with someone whose business address is public or who was referred;
    // WhatsApp and calls only ever with someone who asked for them.
    if (channel !== "email" && contact.consent !== "opted_in") throw new Error(`${channel} needs ${p.name}'s opt-in first; offer it by email and record their yes with bd_record_consent`);
    if (channel === "email" && contact.consent === "none") throw new Error(`No basis to email ${p.name}: record where their business address is published, or a referral`);
    if (channel === "email" && !m.subject?.trim()) throw new Error("An email needs a subject");
    if (!m.body.trim() || m.body.length > 4000) throw new Error("The message must be 1 to 4000 characters");

    const history = await this.all("SELECT direction, created_at FROM financial_products.bd_messages WHERE prospect_id = $1 AND status <> 'refused' ORDER BY created_at", [p.id]);
    const replied = history.some((h) => h.direction === "in");
    const last = history.at(-1);
    const answering = last?.direction === "in";
    if (!replied) {
      const outbound = history.filter((h) => h.direction === "out").length;
      if (outbound >= this.config.maxUnansweredTouches) throw new Error(`${p.name} hasn't replied to ${outbound} messages; stop here`);
      const lastOut = history.filter((h) => h.direction === "out").at(-1);
      if (lastOut && this.now().getTime() - new Date(lastOut.created_at as string).getTime() < this.config.followUpGapDays * 86400e3) {
        throw new Error(`Wait at least ${this.config.followUpGapDays} days between follow-ups`);
      }
    }
    if (!answering && !withinWorkingHours(p.region as string, this.now())) throw new Error(`Outside working hours in ${p.region}; schedule it with next_action_at`);
    const today = await this.one(
      "SELECT count(*)::int AS n FROM financial_products.bd_messages WHERE direction = 'out' AND status IN ('sent', 'draft') AND created_at >= date_trunc('day', $1::timestamptz)",
      [this.now().toISOString()],
    );
    if ((today?.n as number) >= this.config.dailyCap) throw new Error(`Today's cap of ${this.config.dailyCap} messages is used up`);

    const unsubscribe = await this.unsubscribeUrl(contact.id as string);
    const footer =
      channel === "email"
        ? `\n\n--\nI'm ${this.config.senderName}, an AI agent working for Mynt (${this.config.publicUrl}). If you'd rather not hear from Mynt, reply STOP or use ${unsubscribe}`
        : `\n\n(${this.config.senderName}, Mynt's AI agent. Reply STOP to opt out.)`;
    const text = `${m.body.trim()}${footer}`;
    const sender = this.senders[channel];
    let status = "draft";
    let providerId: string | null = null;
    if (sender) {
      const r = await sender.send({ to: contact.address as string, subject: m.subject, text, headers: channel === "email" ? { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : {} });
      status = "sent";
      providerId = r.id;
    }
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO financial_products.bd_messages (id, prospect_id, contact_id, channel, direction, subject, body, status, provider_id, run_id, created_at)
       VALUES ($1, $2, $3, $4, 'out', $5, $6, $7, $8, $9, $10)`,
      [id, p.id, contact.id, channel, m.subject ?? null, text, status, providerId, runId, this.now().toISOString()],
    );
    await this.db.query(
      "UPDATE financial_products.bd_prospects SET stage = CASE WHEN stage = 'sourced' THEN 'contacted' ELSE stage END, updated_at = now() WHERE id = $1",
      [p.id],
    );
    return { id, status, note: status === "draft" ? `${channel} isn't connected yet: saved as a draft for admins` : undefined };
  }

  // A message from a person (provider webhooks and Mynt's own connect tools). STOP opts them out.
  async receive(channel: BdChannel, from: string, m: { subject?: string; body: string }) {
    const c = await this.one("SELECT id, prospect_id FROM financial_products.bd_contacts WHERE address_hash = $1", [hash(normalize(channel, from))]);
    if (!c) return null;
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO financial_products.bd_messages (id, prospect_id, contact_id, channel, direction, subject, body, status, handled, created_at)
       VALUES ($1, $2, $3, $4, 'in', $5, $6, 'received', false, $7)`,
      [id, c.prospect_id, c.id, channel, m.subject ?? null, m.body.slice(0, 20000), this.now().toISOString()],
    );
    if (/^\s*(stop|unsubscribe|opt[\s-]?out)\b/i.test(m.body)) await this.optOut(c.prospect_id as string, "replied STOP");
    else await this.db.query("UPDATE financial_products.bd_prospects SET stage = CASE WHEN stage IN ('sourced', 'contacted') THEN 'engaged' ELSE stage END, updated_at = now() WHERE id = $1", [c.prospect_id]);
    return id;
  }

  async inbox(limit = 50) {
    return this.all(
      `SELECT m.id, m.prospect_id, p.name, p.org, m.channel, m.subject, m.body, m.created_at FROM financial_products.bd_messages m
       JOIN financial_products.bd_prospects p ON p.id = m.prospect_id
       WHERE m.direction = 'in' AND NOT m.handled AND p.stage <> 'suppressed' ORDER BY m.created_at LIMIT $1`,
      [limit],
    );
  }

  async markHandled(ids: string[]) {
    await this.db.query("UPDATE financial_products.bd_messages SET handled = true WHERE id::text = ANY($1)", [ids]);
  }

  // ---- introductions: made only once both people said yes ----

  async proposeIntro(a: string, b: string, reason: string) {
    if (a === b) throw new Error("Pick two different people");
    const id = randomUUID();
    await this.db.query("INSERT INTO financial_products.bd_intros (id, a, b, reason) VALUES ($1, $2, $3, $4)", [id, a, b, reason]);
    return id;
  }

  async introConsent(introId: string, prospectId: string, yes: boolean) {
    const intro = await this.one("SELECT * FROM financial_products.bd_intros WHERE id::text = $1", [introId]);
    if (!intro) throw new Error("No such introduction");
    const side = intro.a === prospectId ? "a" : intro.b === prospectId ? "b" : null;
    if (!side) throw new Error("That person isn't part of this introduction");
    await this.db.query(`UPDATE financial_products.bd_intros SET ${side}_yes = $2, updated_at = now() WHERE id = $1`, [intro.id, yes]);
    await this.ledger(prospectId, "introductions", yes, "consent", `introduction ${intro.id}`, "connector");
    const now = (await this.one("SELECT * FROM financial_products.bd_intros WHERE id = $1", [intro.id]))!;
    const status = now.a_yes === false || now.b_yes === false ? "declined" : now.a_yes && now.b_yes ? "agreed" : "proposed";
    await this.db.query("UPDATE financial_products.bd_intros SET status = $2 WHERE id = $1 AND status <> 'made'", [intro.id, status]);
    return status;
  }

  // Sends each side the other's details, and only once both agreed.
  async makeIntro(introId: string, message: string, runId: string | null) {
    const intro = await this.one("SELECT * FROM financial_products.bd_intros WHERE id::text = $1", [introId]);
    if (!intro || intro.status !== "agreed") throw new Error("Both people must agree before an introduction is made");
    const [a, b] = await Promise.all([this.prospect(intro.a as string), this.prospect(intro.b as string)]);
    const card = (p: NonNullable<typeof a>) => {
      const email = (p.contacts as Row[]).find((c) => c.channel === "email" && c.consent !== "opted_out");
      return `${p.name}${p.org ? `, ${p.org}` : ""}${email ? ` <${email.address}>` : ""}`;
    };
    for (const [to, other] of [[a!, b!], [b!, a!]] as const) {
      await this.send(to.id as string, "email", { subject: `Introduction: ${other.name}`, body: `${message}\n\nYou both said yes to this introduction. Meet ${card(other)}.` }, runId);
    }
    await this.db.query("UPDATE financial_products.bd_intros SET status = 'made', updated_at = now() WHERE id = $1", [intro.id]);
  }

  // ---- agent runs ----

  async runForToken(token: string) {
    return this.one(`SELECT id, status, cap_usd FROM financial_products.bd_runs WHERE token_hash = $1 AND status <> ALL($2)`, [hash(token), RUN_DONE]);
  }

  async agentTokenActive(token: string) {
    return !!(await this.runForToken(token));
  }

  meter: AgentMeter | null = null;
  async agentRun(token: string): Promise<AgentRun | null> {
    const r = await this.runForToken(token);
    return r ? { key: `bd:${r.id}`, capUsd: Number(r.cap_usd) } : null;
  }

  async monthSpend() {
    return Number((await this.one("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM financial_products.bd_runs WHERE created_at >= date_trunc('month', now())"))?.s ?? 0);
  }

  async runs(limit = 20) {
    return this.all("SELECT id, status, cost_usd, cap_usd, summary, error, created_at, finished_at FROM financial_products.bd_runs ORDER BY created_at DESC LIMIT $1", [limit]);
  }

  // Asks for a run now, unless one is already going.
  async requestRun() {
    await this.setSetting("run_requested", true);
  }

  private async finishRun(r: Row, status: string, fields: { summary?: string | null; error?: string | null; cost?: number } = {}) {
    if (r.sandbox_id && this.boat) await this.boat.stop(r.sandbox_id as string).catch(() => {});
    await this.db.query(
      "UPDATE financial_products.bd_runs SET status = $2, token_hash = NULL, summary = COALESCE($3, summary), error = $4, cost_usd = COALESCE($5, cost_usd), finished_at = now() WHERE id = $1",
      [r.id, status, fields.summary ?? null, fields.error ?? null, fields.cost ?? null],
    );
  }

  async stopRuns(reason: string) {
    for (const r of await this.all("SELECT * FROM financial_products.bd_runs WHERE status <> ALL($1)", [RUN_DONE])) await this.finishRun(r, "stopped", { error: reason });
  }

  async tick() {
    await this.sweepRetention();
    if (!this.runnable) return;
    const active = await this.one("SELECT * FROM financial_products.bd_runs WHERE status <> ALL($1) ORDER BY created_at LIMIT 1", [RUN_DONE]);
    if (active) {
      try {
        await this.advance(active);
      } catch (e) {
        await this.finishRun(active, "failed", { error: (e as Error).message });
      }
      return;
    }
    if (await this.paused()) return;
    const last = await this.one("SELECT created_at FROM financial_products.bd_runs ORDER BY created_at DESC LIMIT 1");
    const due = !last || this.now().getTime() - new Date(last.created_at as string).getTime() >= this.config.everyHours * 3600e3;
    const requested = await this.setting<boolean>("run_requested");
    const waiting = (await this.inbox(1)).length > 0 && (!last || this.now().getTime() - new Date(last.created_at as string).getTime() >= 15 * 60e3);
    if (!due && !requested && !waiting) return;
    const left = this.config.monthlyCapUsd - (await this.monthSpend());
    if (left < 0.5) return;
    await this.setSetting("run_requested", false);
    const sandbox = await this.boat!.createSandbox({ name: `mynt-bd-${Date.now()}`, type: this.config.sandboxType, ttlSeconds: 2 * 3600, labels: { mynt_bd: "1" }, env: {} });
    await this.db.query("INSERT INTO financial_products.bd_runs (id, status, sandbox_id, cap_usd, created_at) VALUES ($1, 'provisioning', $2, $3, $4)", [
      randomUUID(),
      sandbox.id,
      Math.min(this.config.runCapUsd, left),
      this.now().toISOString(),
    ]);
  }

  private async advance(r: Row) {
    const boat = this.boat!;
    if (r.status === "provisioning") {
      const s = await boat.getSandbox(r.sandbox_id as string);
      if (s.state === "error" || s.state === "cancelled") throw new Error(`Sandbox ${s.state}`);
      if (!["ready", "idle", "running"].includes(s.state)) return;
      const token = `mynt_bd_${randomBytes(24).toString("base64url")}`;
      await this.db.query("UPDATE financial_products.bd_runs SET token_hash = $2 WHERE id = $1", [r.id, hash(token)]);
      const pid = await launchAgent(boat, this.config, r.sandbox_id as string, {
        prompt: "Run one connector session, following CLAUDE.md and its skills.",
        budgetUsd: Number(r.cap_usd),
        token,
        mcp: true,
        workspace: "connector",
      });
      await this.db.query("UPDATE financial_products.bd_runs SET status = 'running', process_id = $2 WHERE id = $1", [r.id, pid]);
      return;
    }
    const agent = await agentState(boat, r.sandbox_id as string, r.process_id as string);
    const cost = Math.max(agent.cost, this.meter ? await this.meter.spent(`bd:${r.id}`) : 0) + (await boat.costDollars(r.sandbox_id as string));
    await this.db.query("UPDATE financial_products.bd_runs SET cost_usd = $2 WHERE id = $1", [r.id, cost]);
    if (cost > Number(r.cap_usd) + 0.5) return this.finishRun(r, "stopped", { error: `Over the US$${r.cap_usd} run cap`, cost });
    if (agent.running) return;
    await this.finishRun(r, agent.ok ? "finished" : "failed", {
      summary: agent.state?.summary ?? null,
      error: agent.ok ? null : (agent.state?.error ?? agent.state?.last_subtype ?? "agent exited"),
      cost,
    });
  }

  startWorker(intervalMs = Number(process.env.BD_POLL_MS ?? 15000)) {
    if (this.timer) return;
    this.timer = serialLoop(() => this.tick(), intervalMs, "bd worker");
  }

  stopWorker() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async overview() {
    const [stages, today, intros] = await Promise.all([
      this.all("SELECT stage, kind, count(*)::int AS n FROM financial_products.bd_prospects GROUP BY stage, kind ORDER BY stage, kind"),
      this.one(
        "SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent, count(*) FILTER (WHERE status = 'draft')::int AS drafts FROM financial_products.bd_messages WHERE direction = 'out' AND created_at >= date_trunc('day', $1::timestamptz)",
        [this.now().toISOString()],
      ),
      this.all("SELECT status, count(*)::int AS n FROM financial_products.bd_intros GROUP BY status"),
    ]);
    return {
      enabled: this.config.enabled,
      runnable: this.runnable,
      paused: await this.paused(),
      channels: this.channels(),
      caps: { daily_messages: this.config.dailyCap, run_usd: this.config.runCapUsd, monthly_usd: this.config.monthlyCapUsd, every_hours: this.config.everyHours },
      month_spend_usd: await this.monthSpend(),
      today,
      pipeline: stages,
      intros,
      unanswered_inbox: (await this.inbox(200)).length,
    };
  }
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });
const attempt = async (fn: () => Promise<unknown>) => {
  try {
    return json(await fn());
  } catch (e) {
    return fail((e as Error).message);
  }
};

const ContactInput = z.object({
  channel: z.enum(BD_CHANNELS),
  address: z.string().min(3).max(320),
  consent: z.enum(["public_business", "referred", "opted_in"]).describe("public_business: published by them or their firm for business contact (say where in source_url); referred: someone who knows them; opted_in: they asked"),
});

// ---- the connector agent's tools (only inside a BD run) ----

export function registerBdAgentTools(server: McpServer, bd: BdService, runId: string) {
  server.registerTool(
    "bd_brief",
    { title: "Brief", description: "Start here every run: pipeline, today's remaining capacity, connected channels, unanswered replies and due follow-ups.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => json({ ...(await bd.overview()), due_follow_ups: await bd.search({ due: true, limit: 50 }), inbox: await bd.inbox(50) }),
  );
  server.registerTool(
    "bd_add_prospect",
    {
      title: "Add a prospect",
      description:
        "Record someone worth talking to: an innovator (a licensed firm that could offer products on Mynt: bank, NBFC, AMC, insurer, broker, distributor/MFD, payments provider, custodian or exchange) or a developer (who could build experiences on Mynt). Only contact details they or their firm published for business contact, or that a referrer gave; say where in source_url. Refused for anyone who opted out.",
      inputSchema: {
        kind: z.enum(["innovator", "developer"]),
        name: z.string().min(1),
        org: z.string().optional(),
        title: z.string().optional(),
        region: z.string().regex(/^[A-Z]{2}$/).default("IN"),
        source: z.enum(SOURCES),
        source_url: z.string().url().optional().describe("Where you found them and their contact"),
        profile: z.record(z.string(), z.unknown()).optional().describe("What they do, licences, products, stack, interests"),
        notes: z.string().optional(),
        contacts: z.array(ContactInput).default([]),
      },
    },
    async (p) =>
      attempt(async () => {
        if (p.contacts.some((c) => c.consent === "public_business") && !p.source_url) throw new Error("Say where their business contact is published (source_url)");
        return bd.addProspect(p);
      }),
  );
  server.registerTool(
    "bd_find",
    {
      title: "Find prospects",
      description: "Search the pipeline by stage, kind, text, or follow-ups that are due.",
      inputSchema: { stage: z.enum(STAGES).optional(), kind: z.enum(["innovator", "developer"]).optional(), text: z.string().optional(), due: z.boolean().default(false), limit: z.number().int().max(200).default(50) },
      annotations: { readOnlyHint: true },
    },
    async (q) => json(await bd.search(q)),
  );
  server.registerTool(
    "bd_get_prospect",
    { title: "Prospect", description: "One prospect with contacts and consent, the whole conversation, and introductions.", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
    async ({ id }) => ((await bd.prospect(id)) ? json(await bd.prospect(id)) : fail("No such prospect")),
  );
  server.registerTool(
    "bd_update_prospect",
    {
      title: "Update a prospect",
      description: "Move a prospect along (engaged, interested, onboarded, declined), add to what you know about them, or schedule the next step.",
      inputSchema: {
        id: z.string(),
        stage: z.enum(["contacted", "engaged", "interested", "onboarded", "declined"]).optional(),
        profile: z.record(z.string(), z.unknown()).optional().describe("Merged into what's known"),
        notes: z.string().optional(),
        next_action_at: z.string().datetime().nullable().optional(),
      },
    },
    async ({ id, ...u }) => attempt(async () => (await bd.updateProspect(id, u), { updated: id })),
  );
  server.registerTool(
    "bd_send",
    {
      title: "Send a message",
      description:
        "Message a prospect. Mynt adds who you are (an AI agent for Mynt) and an opt-out, and refuses what the rules don't allow: WhatsApp and calls only after they opted in, first emails only with a published business address or a referral, no more than a few unanswered follow-ups spaced days apart, working hours where they are, and a daily cap. Write as yourself, personally and briefly; never claim to be human.",
      inputSchema: { prospect_id: z.string(), channel: z.enum(BD_CHANNELS).default("email"), subject: z.string().max(200).optional(), body: z.string().min(1).max(3500) },
    },
    async ({ prospect_id, channel, subject, body }) => attempt(() => bd.send(prospect_id, channel, { subject, body }, runId)),
  );
  server.registerTool(
    "bd_mark_handled",
    { title: "Mark replies handled", description: "After you've dealt with inbox messages.", inputSchema: { message_ids: z.array(z.string()).min(1) } },
    async ({ message_ids }) => attempt(async () => (await bd.markHandled(message_ids), { handled: message_ids.length })),
  );
  server.registerTool(
    "bd_record_consent",
    {
      title: "Record consent",
      description: "When a person tells you (in a message you received) they want WhatsApp or a call, or that they don't want contact, record it with the message id as evidence. An opt-out stops all contact for good.",
      inputSchema: { prospect_id: z.string(), channel: z.enum(BD_CHANNELS), address: z.string().optional().describe("The number or address they gave"), consent: z.enum(["opted_in", "opted_out"]), evidence_message_id: z.string() },
    },
    async ({ prospect_id, channel, address, consent, evidence_message_id }) =>
      attempt(async () => {
        const msg = (await bd.prospect(prospect_id))?.messages.find((m: Row) => m.id === evidence_message_id && m.direction === "in");
        if (!msg) throw new Error("The evidence must be a message this person sent");
        await bd.recordConsent(prospect_id, channel, address, consent, `message ${evidence_message_id}`);
        return { recorded: consent };
      }),
  );
  server.registerTool(
    "bd_check_consent",
    {
      title: "Check consent",
      description: "Before you write to someone or propose an introduction: whether Mynt allows it now (contact_email, contact_whatsapp, contact_phone, introductions, profile), on what basis, and why not if it doesn't.",
      inputSchema: { prospect_id: z.string(), purpose: z.enum(PURPOSES) },
      annotations: { readOnlyHint: true },
    },
    async ({ prospect_id, purpose }) => json(await bd.checkConsent(prospect_id, purpose)),
  );
  server.registerTool(
    "bd_erase_on_request",
    {
      title: "Erase someone's data on their request",
      description: "When a person asks (in a message you received) for their data to be deleted: erases everything Mynt's connector holds about them and keeps them from being contacted again. Give their message as evidence.",
      inputSchema: { prospect_id: z.string(), evidence_message_id: z.string() },
    },
    async ({ prospect_id, evidence_message_id }) =>
      attempt(async () => {
        const msg = (await bd.prospect(prospect_id))?.messages.find((m: Row) => m.id === evidence_message_id && m.direction === "in");
        if (!msg) throw new Error("The evidence must be a message this person sent");
        await bd.erase(prospect_id, `erasure requested in message ${evidence_message_id}`, "connector");
        return { erased: true };
      }),
  );
  server.registerTool(
    "bd_propose_intro",
    { title: "Propose an introduction", description: "Two people who should meet (an innovator and a developer, or two innovators for distribution). Ask each of them; an intro is only made once both say yes.", inputSchema: { a: z.string(), b: z.string(), reason: z.string().min(10) } },
    async ({ a, b, reason }) => attempt(async () => ({ intro_id: await bd.proposeIntro(a, b, reason) })),
  );
  server.registerTool(
    "bd_intro_answer",
    { title: "Record an intro answer", description: "Record a person's yes or no to an introduction, with the message where they said it.", inputSchema: { intro_id: z.string(), prospect_id: z.string(), yes: z.boolean(), evidence_message_id: z.string() } },
    async ({ intro_id, prospect_id, yes, evidence_message_id }) =>
      attempt(async () => {
        const msg = (await bd.prospect(prospect_id))?.messages.find((m: Row) => m.id === evidence_message_id && m.direction === "in");
        if (!msg) throw new Error("The evidence must be a message this person sent");
        return { status: await bd.introConsent(intro_id, prospect_id, yes) };
      }),
  );
  server.registerTool(
    "bd_make_intro",
    { title: "Make an introduction", description: "Email both people, introducing each to the other. Only once both said yes.", inputSchema: { intro_id: z.string(), message: z.string().min(20).max(2000) } },
    async ({ intro_id, message }) => attempt(async () => (await bd.makeIntro(intro_id, message, runId), { made: intro_id })),
  );
}

// ---- for everyone signed in: tell the connector about yourself, refer people, answer intros ----

export function registerConnectTools(server: McpServer, bd: BdService, user: User) {
  server.registerTool(
    "connect_with_mynt",
    {
      title: "Talk to Mynt's connector",
      description:
        "Tell Mynt's connector (an AI agent) what you do and what you're looking for: an innovator bringing financial products, or a developer building on them. It introduces you to the right people, with your yes first. Give WhatsApp or a phone number only if you'd like to be reached there.",
      inputSchema: {
        kind: z.enum(["innovator", "developer"]),
        about: z.string().min(10).max(3000).describe("What you or your firm does: licences, products, stack, customers"),
        looking_for: z.string().min(5).max(2000).describe("Who you'd like to meet, or what you need"),
        org: z.string().optional(),
        region: z.string().regex(/^[A-Z]{2}$/).default("IN"),
        whatsapp: z.string().optional(),
        phone: z.string().optional().describe("For a call, if you'd like one"),
      },
    },
    async (i) =>
      attempt(async () => {
        const contacts: { channel: BdChannel; address: string; consent: Consent; consent_source: string }[] = [];
        if (user.email) contacts.push({ channel: "email", address: user.email, consent: "opted_in", consent_source: "connect_with_mynt" });
        if (i.whatsapp) contacts.push({ channel: "whatsapp", address: i.whatsapp, consent: "opted_in", consent_source: "connect_with_mynt" });
        if (i.phone) contacts.push({ channel: "phone", address: i.phone, consent: "opted_in", consent_source: "connect_with_mynt" });
        const { id } = await bd.addProspect({ kind: i.kind, name: user.name, org: i.org, region: i.region, source: "inbound", user_id: user.id, contacts });
        await bd.updateProspect(id, { stage: "engaged", profile: { about: i.about, looking_for: i.looking_for } });
        if (user.email) await bd.receive("email", user.email, { subject: "Via Mynt (connect_with_mynt)", body: `${i.about}\n\nLooking for: ${i.looking_for}` });
        await bd.requestRun();
        return { received: true, next: "The connector will reply by email, and on WhatsApp or by phone if you gave a number." };
      }),
  );
  server.registerTool(
    "connect_refer",
    {
      title: "Refer someone to Mynt",
      description: "Point Mynt's connector to someone who should be on Mynt (an innovator or a developer). It will reach out once by email, saying you referred them only if you allow it.",
      inputSchema: {
        kind: z.enum(["innovator", "developer"]),
        name: z.string().min(1),
        org: z.string().optional(),
        email: z.string().email(),
        why: z.string().min(10).max(1000),
        may_mention_me: z.boolean().default(false),
      },
    },
    async (r) =>
      attempt(async () => {
        const { id, existing } = await bd.addProspect({
          kind: r.kind,
          name: r.name,
          org: r.org,
          source: "referral",
          notes: `Referred by ${r.may_mention_me ? `${user.name} (may be mentioned)` : "a Mynt user (don't name them)"}: ${r.why}`,
          contacts: [{ channel: "email", address: r.email, consent: "referred", consent_source: `referral by user ${user.id}` }],
        });
        return { referred: true, already_known: existing, prospect: id };
      }),
  );
  server.registerTool(
    "connect_forget_me",
    {
      title: "Forget me",
      description: "Erase everything Mynt's connector holds about you (profile, messages, introductions, consents), and never contact you again. Your Mynt account itself isn't affected.",
      inputSchema: { confirm: z.literal(true) },
    },
    async () =>
      attempt(async () => {
        const me = await bd.prospectForUser(user.id);
        if (!me) return { erased: false, note: "The connector holds nothing about you" };
        await bd.erase(me.id as string, "erasure requested by the person", `user ${user.id}`);
        return { erased: true };
      }),
  );
  server.registerTool(
    "connect_my_intros",
    { title: "My introductions", description: "Introductions Mynt's connector has proposed for you; answer them with connect_answer_intro.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => {
      const me = await bd.prospectForUser(user.id);
      return json(me ? (await bd.prospect(me.id as string))!.intros : []);
    },
  );
  server.registerTool(
    "connect_answer_intro",
    { title: "Answer an introduction", description: "Say yes or no to meeting someone the connector suggested.", inputSchema: { intro_id: z.string(), yes: z.boolean() } },
    async ({ intro_id, yes }) =>
      attempt(async () => {
        const me = await bd.prospectForUser(user.id);
        if (!me) throw new Error("Tell the connector about yourself first (connect_with_mynt)");
        const status = await bd.introConsent(intro_id, me.id as string, yes);
        if (status === "agreed") await bd.requestRun();
        return { status };
      }),
  );
}

// ---- admins: oversight and the kill switch ----

export function registerBdAdminTools(server: McpServer, bd: BdService, audit: (action: string, target: string, details?: unknown) => Promise<unknown>) {
  server.registerTool(
    "bd_overview",
    { title: "Connector overview", description: "Admin: the connector agent's pipeline, today's messages and drafts, channels, spend and caps.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => json({ ...(await bd.overview()), recent_runs: await bd.runs(10) }),
  );
  server.registerTool(
    "bd_prospects",
    { title: "Connector prospects", description: "Admin: browse the pipeline, or open one prospect with their whole conversation.", inputSchema: { id: z.string().optional(), stage: z.enum(STAGES).optional(), text: z.string().optional() }, annotations: { readOnlyHint: true } },
    async ({ id, stage, text }) => (id ? json((await bd.prospect(id)) ?? { error: "No such prospect" }) : json(await bd.search({ stage, text, limit: 200 }))),
  );
  server.registerTool(
    "bd_pause",
    { title: "Pause or resume the connector", description: "Admin: the kill switch. Pausing stops any running agent and refuses every message until resumed.", inputSchema: { paused: z.boolean(), reason: z.string().min(3) } },
    async ({ paused, reason }) =>
      attempt(async () => {
        await bd.setSetting("pause", { paused, reason });
        if (paused) await bd.stopRuns(`Paused: ${reason}`);
        await audit(paused ? "bd_pause" : "bd_resume", "connector", { reason });
        return { paused };
      }),
  );
  server.registerTool(
    "bd_suppress",
    { title: "Suppress an address", description: "Admin: never contact this email or number again (e.g. a request received elsewhere).", inputSchema: { channel: z.enum(BD_CHANNELS), address: z.string().min(3), reason: z.string().min(3) } },
    async ({ channel, address, reason }) => attempt(async () => (await bd.suppress(channel, address, reason), await audit("bd_suppress", channel, { reason }), { suppressed: true })),
  );
  server.registerTool(
    "bd_erase",
    {
      title: "Erase a prospect's data",
      description: "Admin: erase everything the connector holds about a person (e.g. a request received elsewhere). By default they also stay suppressed; only the hashes and the reason remain.",
      inputSchema: { prospect_id: z.string(), reason: z.string().min(3), keep_suppressed: z.boolean().default(true) },
    },
    async ({ prospect_id, reason, keep_suppressed }) =>
      attempt(async () => {
        if (!(await bd.erase(prospect_id, reason, "admin", { suppress: keep_suppressed }))) throw new Error("No such prospect");
        await audit("bd_erase", "connector", { reason, keep_suppressed });
        return { erased: true };
      }),
  );
  server.registerTool(
    "bd_run_now",
    { title: "Run the connector now", description: "Admin: start a connector run at the next tick instead of waiting for the schedule.", inputSchema: {} },
    async () => attempt(async () => (await bd.requestRun(), await audit("bd_run_now", "connector"), { requested: true, runnable: bd.runnable })),
  );
}
