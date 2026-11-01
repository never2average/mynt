import { createHash, randomBytes, randomUUID } from "node:crypto";
import { serialLoop } from "./worker.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { coveringLicenses } from "./access.js";
import { agentState, launchAgent, workspaceCwd, WORKSPACES_ROOT, type AgentHostConfig } from "./agent-host.js";
import type { BoatClient } from "./boat.js";
import type { Db } from "./db.js";
import { feasibilityCheck, type DeskService } from "./desk.js";
import { evidenceChecker, type Fetcher } from "./evidence.js";
import { fingerprint } from "./product-tests.js";
import { blockingComponents, productRegime } from "./regime.js";
import { normalizeModel } from "./regulatory.js";
import type { Store, User } from "./store.js";

// The governance desk: an agent reviews a firm, a licence it claims or a product it offers, and admins
// decide. The agent is steered by Mynt's workspaces/governance-review folder (its CLAUDE.md, skills,
// checklists and scripts) and does only the research and judgement. Mynt computes the items it can from
// its own records, re-checks every quote the agent cites, and computes the recommendation itself.
// Nothing changes until an admin decides.

export const SUBJECTS = ["entity", "license", "product"] as const;
export type Subject = (typeof SUBJECTS)[number];
// met / not_met: evidence shows it; silent: sources say nothing either way (with what was searched);
// unverified: the evidence cited couldn't be confirmed; not_reviewed: no usable answer.
export type ItemStatus = "met" | "not_met" | "silent" | "unverified" | "not_reviewed";
const WORKSPACE = "governance-review";

interface ChecklistItem {
  id: string;
  by: "mynt" | "agent";
  material: boolean;
  title: string;
  requirement: string;
}
export interface ItemResult {
  id: string;
  title: string;
  material: boolean;
  by: "mynt" | "agent";
  status: ItemStatus;
  evidence: { source_url: string; quote: string; verified: boolean; reason?: string }[];
  searched_for: string | null;
  note: string | null;
}

export function checklist(subject: Subject, root = WORKSPACES_ROOT): ChecklistItem[] {
  return (JSON.parse(readFileSync(join(root, WORKSPACE, "checklists", `${subject}.json`), "utf8")) as { items: ChecklistItem[] }).items;
}

// Mynt's recommendation from the item results; never the agent's.
export function recommend(items: ItemResult[]) {
  const by = (s: ItemStatus[], material?: boolean) => items.filter((i) => s.includes(i.status) && (material === undefined || i.material === material));
  const unreviewed = by(["not_reviewed"]);
  if (items.length === 0) return { verdict: "incomplete" as const, reason: "No checklist applies" };
  if (unreviewed.length / items.length > 0.2) return { verdict: "incomplete" as const, reason: `${unreviewed.length} of ${items.length} items weren't reviewed; no recommendation` };
  const failed = by(["not_met"], true);
  if (failed.length) return { verdict: "reject" as const, reason: `Fails: ${failed.map((i) => i.title).join("; ")}` };
  const open = by(["silent", "unverified", "not_reviewed"], true);
  if (open.length) return { verdict: "needs_info" as const, reason: `Not confirmed: ${open.map((i) => i.title).join("; ")}` };
  const minor = by(["not_met", "silent", "unverified"], false);
  return { verdict: "verify" as const, reason: minor.length ? `Material items confirmed; minor open points: ${minor.map((i) => i.title).join("; ")}` : "Every item confirmed" };
}

export interface ReviewConfig extends AgentHostConfig {
  caseCapUsd: number;
  monthlyCapUsd: number;
  autoOpen: boolean; // open a case for every licence awaiting review
  sandboxType: string;
}

export function reviewConfigFromEnv(host: AgentHostConfig, env = process.env): ReviewConfig {
  return {
    ...host,
    caseCapUsd: Number(env.REVIEW_CASE_CAP_USD ?? 3),
    monthlyCapUsd: Number(env.REVIEW_MONTHLY_CAP_USD ?? 60),
    autoOpen: env.REVIEW_AUTO_OPEN === "1",
    sandboxType: env.BUILD_SANDBOX_TYPE ?? "default",
  };
}

const TABLES = `
  CREATE TABLE IF NOT EXISTS financial_products.review_cases (
    id uuid PRIMARY KEY,
    subject_kind text NOT NULL CHECK (subject_kind IN ('entity', 'license', 'product')),
    subject_id text NOT NULL,
    entity_id uuid,
    status text NOT NULL,
    phase_message text,
    snapshot jsonb NOT NULL,
    snapshot_hash text NOT NULL,
    sandbox_id text,
    process_id text,
    token_hash text,
    items jsonb,
    recommendation jsonb,
    agent_summary text,
    suggestions jsonb,
    cost_usd numeric NOT NULL DEFAULT 0,
    cap_usd numeric NOT NULL,
    opened_by uuid REFERENCES financial_products.users(id),
    decision text,
    decision_note text,
    decided_by uuid REFERENCES financial_products.users(id),
    decided_at timestamptz,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS review_cases_subject_idx ON financial_products.review_cases (subject_kind, subject_id, created_at DESC);
`;

const RUNNING = ["queued", "provisioning", "reviewing"];
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type Row = Record<string, unknown>;

export class ReviewService {
  private timer: NodeJS.Timeout | null = null;

  private constructor(
    private readonly db: Db,
    private readonly store: Store,
    readonly boat: BoatClient | null,
    readonly config: ReviewConfig,
    private readonly desk: DeskService | null,
    private readonly fetcher?: Fetcher,
  ) {}

  static async open(db: Db, store: Store, boat: BoatClient | null, config: ReviewConfig, desk: DeskService | null = null, fetcher?: Fetcher) {
    await db.exec(TABLES);
    return new ReviewService(db, store, boat, config, desk, fetcher);
  }

  get enabled() {
    return !!this.boat && !!this.config.agentBackend && !!this.config.publicUrl;
  }

  private async all(sql: string, params: unknown[] = []) {
    return (await this.db.query(sql, params)).rows as Row[];
  }

  private async one(sql: string, params: unknown[] = []) {
    return (await this.all(sql, params))[0];
  }

  // ---- the case: a frozen snapshot of what's reviewed, with Mynt's own items decided up front ----

  private async regulatoryFor(region: string, regulatorId: string | null, licenceId: string | null) {
    const r = (await this.store.referenceData(true)).regions.find((x) => x.code === region);
    if (!r) return { region, regulator: null, licence_type: null, law: [] };
    const model = normalizeModel(r.regulatory);
    const regulator = regulatorId ? model.regulators.find((x) => x.id === regulatorId) : undefined;
    const licence = regulator && licenceId ? regulator.license_types.find((l) => l._id === licenceId) : undefined;
    const law = model.legal.legislative
      .filter((l) => !regulator || l.issued_by === regulator.id || (l.applies_to?.regulators ?? []).includes(regulator.id))
      .slice(0, 60)
      .map((l) => ({ legal_ref: l.id, kind: l.kind, title: l.title, status: l.status, summary: l.summary, url: l.url }));
    return {
      region,
      regulator: regulator ? { id: regulator.id, name: regulator.name, short_name: regulator.short_name } : null,
      licence_type: licence ? { id: licence._id, name: licence.name, scope: licence.scope, allowed_customer_segments: licence.grc.allowed_customer_segments } : null,
      law,
    };
  }

  private async snapshot(kind: Subject, id: string) {
    const mine = (item: string, status: ItemStatus, quote: string): Pick<ItemResult, "id" | "status" | "evidence" | "note"> => ({
      id: item,
      status,
      evidence: [{ source_url: "mynt://records", quote, verified: true }],
      note: null,
    });
    const decided: Pick<ItemResult, "id" | "status" | "evidence" | "note">[] = [];
    let subject: Record<string, unknown>;
    let regulatory: Awaited<ReturnType<ReviewService["regulatoryFor"]>> | Record<string, unknown> = {};
    let entityId: string | null;
    let facts: Record<string, string[]> = {};

    if (kind === "license") {
      const held = await this.store.getHeldLicense(id);
      if (!held) throw new Error(`No licence record '${id}'`);
      const entity = await this.store.getEntity(held.entity_id);
      regulatory = await this.regulatoryFor(held.region, held.regulator_id, held.license_id);
      subject = { licence: held, entity };
      entityId = held.entity_id;
      facts = { regions: [held.region], regulators: [held.regulator_id], license_types: [held.license_id] };
      decided.push(
        regulatory.licence_type
          ? mine("licence_type_defined", "met", `${held.regulator_id} / ${held.license_id} is defined in ${held.region}`)
          : mine("licence_type_defined", "not_met", `${held.regulator_id} / ${held.license_id} isn't in ${held.region}'s regulatory model`),
      );
    } else if (kind === "entity") {
      const entity = await this.store.getEntity(id);
      if (!entity) throw new Error(`No firm '${id}'`);
      subject = { entity };
      entityId = entity.id;
      facts = { regions: entity.regions };
      const ids = Object.entries(entity.registration_numbers ?? {});
      decided.push(ids.length ? mine("registration_ids_given", "met", ids.map(([k, v]) => `${k}: ${v}`).join(", ")) : mine("registration_ids_given", "not_met", "No registration numbers recorded"));
    } else {
      const p = await this.store.getProduct(id);
      if (!p) throw new Error(`No product '${id}'`);
      entityId = p.entity_id;
      const held = await coveringLicenses(this.store, p.entity_id, p.product.region, p.product.category, p.action);
      const first = held[0];
      regulatory = await this.regulatoryFor(p.product.region, first?.regulator_id ?? null, first?.license_id ?? null);
      const terms = this.desk ? await this.desk.terms(id) : null;
      // A composed product's regime comes from its components; otherwise from its category and action.
      const regime = p.components.length ? await productRegime(this.store, p) : null;
      subject = { product: { ...p.product, action: p.action, build_terms: p.build_terms }, term_sheet: terms?.terms ?? null, covering_licences: held, regime };
      facts = {
        regions: [p.product.region],
        product_lines: [p.product.product_line],
        categories: [p.product.category],
        regulators: regime ? [...new Set(regime.regions.flatMap((r) => r.regulators))] : held.map((h) => h.regulator_id),
      };
      if (regime) {
        const blocking = blockingComponents(regime, p.product.region);
        decided.push(
          blocking.length
            ? mine("covered_by_verified_licence", "not_met", `Not covered: ${blocking.map((b) => `${b.primitive} (${b.action}, ${b.region})`).join("; ")}`)
            : mine("covered_by_verified_licence", "met", `Every component is covered (${regime.regions.map((r) => r.region).join(", ")})`),
        );
      } else {
        decided.push(
          held.length
            ? mine("covered_by_verified_licence", "met", held.map((h) => `${h.regulator_id}/${h.license_id} ${h.registration_number} (verified)`).join("; "))
            : mine("covered_by_verified_licence", "not_met", `No verified licence covers ${p.action} of ${p.product.category} in ${p.product.region}`),
        );
      }
      const personas = p.build_terms?.allowed_personas ?? [];
      const segments = new Set(((regulatory as { licence_type?: { allowed_customer_segments?: string[] } | null }).licence_type?.allowed_customer_segments) ?? []);
      decided.push(
        personas.length === 0
          ? mine("segments_within_grant", "met", "The product isn't limited to particular customer personas")
          : personas.every((x) => segments.has(x))
            ? mine("segments_within_grant", "met", `Personas ${personas.join(", ")} are allowed segments`)
            : mine("segments_within_grant", "not_met", `Personas outside the licence: ${personas.filter((x) => !segments.has(x)).join(", ")}`),
      );
      const tested = p.last_test && p.last_test.passed && p.last_test.fingerprint === fingerprint(p.product);
      decided.push(tested ? mine("product_tests_pass", "met", `Passed on ${p.last_test!.ran_at}`) : mine("product_tests_pass", "not_met", p.last_test ? "The latest test didn't pass or is out of date" : "Never tested"));
      if (this.desk) {
        const f = await feasibilityCheck(this.desk, id);
        decided.push(mine("feasibility_current", f.status === "pass" ? "met" : /infeasible/.test(f.message) ? "not_met" : "silent", f.message));
      } else decided.push({ id: "feasibility_current", status: "silent", evidence: [], note: "The product desk isn't enabled" });
    }

    const list = checklist(kind);
    const snapshot = {
      subject_kind: kind,
      subject,
      facts,
      regulatory,
      items: list.filter((i) => i.by === "agent").map(({ id: itemId, title, requirement, material }) => ({ id: itemId, title, requirement, material })),
      decided_by_mynt: decided,
    };
    return { snapshot, entityId };
  }

  async openCase(kind: Subject, subjectId: string, openedBy: string | null) {
    if (!this.enabled) throw new Error("Governance reviews aren't enabled on this Mynt yet");
    const running = await this.one("SELECT id FROM financial_products.review_cases WHERE subject_kind = $1 AND subject_id = $2 AND status = ANY($3)", [kind, subjectId, RUNNING]);
    if (running) throw new Error(`A review of this ${kind} is already running (${running.id})`);
    const committed = Number((await this.one(
      `SELECT COALESCE(SUM(CASE WHEN status = ANY($1) THEN cap_usd ELSE cost_usd END), 0) AS s FROM financial_products.review_cases WHERE created_at >= date_trunc('month', now())`,
      [RUNNING],
    ))?.s ?? 0);
    if (committed + this.config.caseCapUsd > this.config.monthlyCapUsd) throw new Error(`This month's review budget of US$${this.config.monthlyCapUsd} is used up`);
    const { snapshot, entityId } = await this.snapshot(kind, subjectId);
    const text = JSON.stringify(snapshot);
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO financial_products.review_cases (id, subject_kind, subject_id, entity_id, status, snapshot, snapshot_hash, cap_usd, opened_by)
       VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7, $8)`,
      [id, kind, subjectId, entityId, text, hash(text), this.config.caseCapUsd, openedBy],
    );
    return (await this.get(id))!;
  }

  async get(id: string) {
    const r = await this.one("SELECT * FROM financial_products.review_cases WHERE id::text = $1", [id]);
    if (!r) return null;
    const { token_hash: _, ...rest } = r;
    return rest;
  }

  async list(status?: string) {
    return (
      await this.all(
        `SELECT id, subject_kind, subject_id, status, recommendation, decision, cost_usd, created_at, finished_at FROM financial_products.review_cases
         WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT 200`,
        [status ?? null],
      )
    );
  }

  async agentTokenActive(token: string) {
    return !!(await this.one("SELECT 1 FROM financial_products.review_cases WHERE token_hash = $1 AND status = ANY($2)", [hash(token), RUNNING]));
  }

  private async update(id: string, f: Row) {
    const keys = Object.keys(f);
    const done = typeof f.status === "string" && !RUNNING.includes(f.status);
    await this.db.query(
      `UPDATE financial_products.review_cases SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}${done ? ", token_hash = NULL, finished_at = COALESCE(finished_at, now())" : ""} WHERE id = $1`,
      [id, ...keys.map((k) => (["items", "recommendation", "suggestions"].includes(k) ? JSON.stringify(f[k]) : f[k]))],
    );
  }

  private async end(c: Row, status: string, f: Row = {}) {
    if (c.sandbox_id && this.boat) await this.boat.stop(c.sandbox_id as string).catch(() => {});
    await this.update(c.id as string, { ...f, status });
  }

  async stop(id: string, reason: string) {
    const c = await this.one("SELECT * FROM financial_products.review_cases WHERE id::text = $1", [id]);
    if (!c || !RUNNING.includes(c.status as string)) return false;
    await this.end(c, "stopped", { error: reason });
    return true;
  }

  // Applies an admin's decision. Only a licence decision changes anything: verify or reject sets the
  // licence's review status, exactly as review_license does.
  async decide(id: string, admin: User, decision: "verify" | "reject" | "needs_info", note: string) {
    const c = await this.one("SELECT * FROM financial_products.review_cases WHERE id::text = $1", [id]);
    if (!c) throw new Error("No such review case");
    if (c.status !== "ready") throw new Error(`The case is ${c.status}; only a ready case can be decided`);
    let applied: string | null = null;
    if (c.subject_kind === "license" && decision !== "needs_info") {
      await this.store.reviewLicense(c.subject_id as string, decision === "verify" ? "verified" : "rejected", admin.id, note);
      applied = decision === "verify" ? "licence verified" : "licence rejected";
    }
    await this.db.query(
      "UPDATE financial_products.review_cases SET status = 'decided', decision = $2, decision_note = $3, decided_by = $4, decided_at = now() WHERE id = $1",
      [c.id, decision, note, admin.id],
    );
    await this.store.audit(admin.id, "decide_review_case", `${c.subject_kind}/${c.subject_id}`, { case: c.id, decision, recommendation: c.recommendation, applied });
    return { decision, applied };
  }

  // ---- the worker ----

  async tick() {
    if (!this.enabled) return;
    if (this.config.autoOpen) {
      for (const l of await this.all(
        `SELECT h.id FROM financial_products.held_licenses h WHERE h.status = 'pending'
         AND NOT EXISTS (SELECT 1 FROM financial_products.review_cases c WHERE c.subject_kind = 'license' AND c.subject_id = h.id::text) LIMIT 3`,
      )) {
        await this.openCase("license", l.id as string, null).catch(() => {});
      }
    }
    for (const c of await this.all("SELECT * FROM financial_products.review_cases WHERE status = ANY($1) ORDER BY created_at", [RUNNING])) {
      try {
        await this.advance(c);
      } catch (e) {
        await this.end(c, "failed", { error: (e as Error).message });
      }
    }
  }

  private async advance(c: Row) {
    const boat = this.boat!;
    if (c.status === "queued") {
      const s = await boat.createSandbox({ name: `mynt-review-${c.id}`, type: this.config.sandboxType, ttlSeconds: 2 * 3600, labels: { mynt_review: c.id as string }, env: {} });
      await this.update(c.id as string, { status: "provisioning", sandbox_id: s.id, phase_message: "Sandbox requested" });
      return;
    }
    if (c.status === "provisioning") {
      const s = await boat.getSandbox(c.sandbox_id as string);
      if (s.state === "error" || s.state === "cancelled") throw new Error(`Sandbox ${s.state}`);
      if (!["ready", "idle", "running"].includes(s.state)) return;
      const token = `mynt_review_${randomBytes(24).toString("base64url")}`;
      await this.update(c.id as string, { token_hash: hash(token) });
      const pid = await launchAgent(boat, this.config, c.sandbox_id as string, {
        prompt: "Review the case in job/case.json, following CLAUDE.md and its skills. Write job/review.json and run scripts/check_review.py until it passes.",
        budgetUsd: Number(c.cap_usd),
        token,
        workspace: WORKSPACE,
        jobFiles: { "job/case.json": JSON.stringify(c.snapshot, null, 1) },
      });
      await this.update(c.id as string, { status: "reviewing", process_id: pid, phase_message: "The review agent is researching" });
      return;
    }
    const agent = await agentState(boat, c.sandbox_id as string, c.process_id as string);
    const cost = agent.cost + (await boat.costDollars(c.sandbox_id as string));
    await this.update(c.id as string, { cost_usd: cost });
    if (cost > Number(c.cap_usd) + 0.5) return this.end(c, "stopped", { error: `Over the US$${c.cap_usd} case cap`, cost_usd: cost });
    if (agent.running) return;
    const raw = await boat.readFile(c.sandbox_id as string, `${workspaceCwd(WORKSPACE)}/job/review.json`);
    const items = await this.assess(c.snapshot as Row, raw);
    await this.end(c, "ready", {
      items,
      recommendation: recommend(items),
      agent_summary: agent.state?.summary ?? null,
      suggestions: parseSuggestions(raw),
      phase_message: agent.ok ? "Ready for an admin's decision" : `The agent didn't finish cleanly (${agent.state?.last_subtype ?? "exited"}); unanswered items count as not reviewed`,
    });
  }

  // Mynt's own pass over the agent's answers: unknown statuses and absence claims without a search are
  // not reviewed; positive and negative findings need at least one quote Mynt can find in its source.
  async assess(snapshot: Row, raw: string | null): Promise<ItemResult[]> {
    const kind = snapshot.subject_kind as Subject;
    const list = checklist(kind);
    const decided = new Map(((snapshot.decided_by_mynt as ItemResult[]) ?? []).map((d) => [d.id, d]));
    let reported: Row[] = [];
    try {
      const parsed = raw ? (JSON.parse(raw) as { items?: Row[] }) : {};
      reported = Array.isArray(parsed.items) ? parsed.items : [];
    } catch {
      reported = [];
    }
    const byId = new Map(reported.map((r) => [r.id as string, r]));
    const check = evidenceChecker({ fetcher: this.fetcher, caseText: JSON.stringify(snapshot, null, 1) });
    const out: ItemResult[] = [];
    for (const item of list) {
      const base = { id: item.id, title: item.title, material: item.material, by: item.by };
      if (item.by === "mynt") {
        const d = decided.get(item.id);
        out.push({ ...base, status: d?.status ?? "not_reviewed", evidence: d?.evidence ?? [], searched_for: null, note: d?.note ?? null });
        continue;
      }
      const r = byId.get(item.id);
      const status = r?.status as string | undefined;
      if (!r || !["met", "not_met", "silent"].includes(status ?? "")) {
        out.push({ ...base, status: "not_reviewed", evidence: [], searched_for: null, note: r ? "Unknown status" : "Not answered" });
        continue;
      }
      const searched = typeof r.searched_for === "string" && r.searched_for.trim() ? r.searched_for.slice(0, 2000) : null;
      const note = typeof r.note === "string" ? r.note.slice(0, 2000) : null;
      const cited = (Array.isArray(r.evidence) ? (r.evidence as Row[]) : [])
        .filter((e) => typeof e?.source_url === "string" && typeof e?.quote === "string")
        .slice(0, 10) as { source_url: string; quote: string }[];
      const evidence = [];
      for (const e of cited) {
        const v = await check(e);
        evidence.push({ source_url: e.source_url.slice(0, 2000), quote: e.quote.slice(0, 2000), verified: v.verified, ...(v.verified ? {} : { reason: v.reason }) });
      }
      if (status === "silent") {
        out.push({ ...base, status: searched ? "silent" : "not_reviewed", evidence, searched_for: searched, note: searched ? note : "Said 'silent' without saying what was searched for" });
        continue;
      }
      out.push({ ...base, status: evidence.some((e) => e.verified) ? (status as "met" | "not_met") : "unverified", evidence, searched_for: searched, note });
    }
    return out;
  }

  startWorker(intervalMs = Number(process.env.REVIEW_POLL_MS ?? 10000)) {
    if (this.timer || !this.enabled) return;
    this.timer = serialLoop(() => this.tick(), intervalMs, "review worker");
  }

  stopWorker() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function parseSuggestions(raw: string | null) {
  try {
    const s = (JSON.parse(raw ?? "{}") as { suggestions?: unknown }).suggestions;
    return Array.isArray(s) ? s.filter((x) => typeof x === "string").slice(0, 10).map((x) => (x as string).slice(0, 1000)) : [];
  } catch {
    return [];
  }
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

export function registerReviewTools(server: McpServer, review: ReviewService, admin: User) {
  server.registerTool(
    "open_review_case",
    {
      title: "Open a governance review",
      description:
        "Admin: have the review agent check a firm (entity id), a licence it registered (licence record id) or a product (product id) against public sources and Mynt's regulatory model. Mynt decides what it can from its own records, verifies every quote the agent cites, and recommends; you decide with decide_review_case.",
      inputSchema: { subject_kind: z.enum(SUBJECTS), subject_id: z.string().min(1) },
    },
    async ({ subject_kind, subject_id }) => {
      try {
        const c = await review.openCase(subject_kind, subject_id, admin.id);
        return json({ case_id: c.id, status: c.status });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );
  server.registerTool(
    "list_review_cases",
    { title: "Governance review cases", description: "Admin: review cases with their status, Mynt's recommendation and any decision.", inputSchema: { status: z.enum(["queued", "provisioning", "reviewing", "ready", "decided", "failed", "stopped"]).optional() }, annotations: { readOnlyHint: true } },
    async ({ status }) => json(await review.list(status)),
  );
  server.registerTool(
    "get_review_case",
    { title: "A governance review case", description: "Admin: the dossier: every checklist item with its status, verified and unverified evidence, what was searched, the agent's notes and Mynt's recommendation.", inputSchema: { case_id: z.string() }, annotations: { readOnlyHint: true } },
    async ({ case_id }) => {
      const c = await review.get(case_id);
      return c ? json(c) : fail("No such review case");
    },
  );
  server.registerTool(
    "decide_review_case",
    {
      title: "Decide a governance review",
      description: "Admin: your decision on a ready case. For a licence, verify or reject sets its review status (as review_license does); needs_info records it and changes nothing. Recorded in the audit log with Mynt's recommendation.",
      inputSchema: { case_id: z.string(), decision: z.enum(["verify", "reject", "needs_info"]), note: z.string().min(3).max(2000) },
    },
    async ({ case_id, decision, note }) => {
      try {
        return json(await review.decide(case_id, admin, decision, note));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );
  server.registerTool(
    "stop_review_case",
    { title: "Stop a governance review", description: "Admin: stop a running review and its sandbox.", inputSchema: { case_id: z.string() } },
    async ({ case_id }) => ((await review.stop(case_id, `Stopped by ${admin.name}`)) ? json({ stopped: case_id }) : fail("No running review with that id")),
  );
}
