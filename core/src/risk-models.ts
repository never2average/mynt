import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "./db.js";
import { RISK_MODEL_OUTCOMES, RISK_MODEL_STATUSES } from "./risk-models-schema.js";
import { risksLinkedToModel } from "./risk-detail.js";
import { RISK_AREAS, type RiskArea } from "./risk-register-schema.js";
import { effectiveRoles, type Store, type User } from "./store.js";

// Mynt's own risk models: how the platform measures each of its seven risk areas (financial, compliance, third_party,
// operations, business_process, technology, regulated_product). Each model has a name, a purpose, its method (the
// formula or approach, in words), its inputs, outputs and thresholds (JSON lists), an owner (a Mynt admin), a status
// (draft, active, retired) and its validation: the last one (when, by whom, the outcome, notes) and when the next is
// due. Editing a model's definition adds a version and never changes an old one; every version and every validation
// is kept. A model whose next validation date has passed (and that isn't retired) is overdue, and ops_status says so.
// Kept and read by Mynt's admins only; every change is audited (class obligations, audit-classes.ts).
//
// A model's health is derived, in words: "Last validation failed", "Validation overdue" (its next validation date has
// passed), "No validation yet", else "Healthy"; a retired model is "Retired" and never counted. ops_status counts the
// models that aren't healthy. Risks on a register can link to a model (risk-detail.ts link_risk, target risk_model):
// each model says how many do, and its page lists them.
//
// admin_list_product_risk_models reads the risk models financial products declare in their own definitions (the
// product schema's risk_models), across every firm, for the platform admin's Regulated product risk tab. Read-only.

const T = "financial_products";
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

type Row = Record<string, unknown>;
const UUID = z.string().uuid();
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date as YYYY-MM-DD");
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const day = (v: unknown) => (v == null ? null : typeof v === "string" ? v.slice(0, 10) : new Date(v as Date).toISOString().slice(0, 10));
const today = () => new Date().toISOString().slice(0, 10);

const NAME = z.string().trim().min(1).max(120);
const TEXT = z.string().trim().max(2000);
const INPUT = z.object({ name: NAME, description: TEXT.optional(), source: TEXT.optional().describe("Where it comes from: a table, a feed, a vendor") }).strict();
const OUTPUT = z.object({ name: NAME, description: TEXT.optional() }).strict();
const THRESHOLD = z
  .object({ name: NAME, value: z.union([z.number(), z.string().trim().min(1).max(200)]).describe("The level, a number or words"), meaning: TEXT.optional().describe("What happens at or beyond it") })
  .strict();
const DEFINITION = {
  name: z.string().trim().min(3).max(200),
  purpose: z.string().trim().min(3).max(4000).describe("What the model is for"),
  method: z.string().trim().min(3).max(8000).describe("The formula or approach, in words"),
  inputs: z.array(INPUT).max(50),
  outputs: z.array(OUTPUT).max(50).describe("The scores or measures it produces"),
  thresholds: z.array(THRESHOLD).max(50),
};
type Definition = { name: string; purpose: string; method: string; inputs: unknown[]; outputs: unknown[]; thresholds: unknown[] };
const DEFINITION_KEYS = ["name", "purpose", "method", "inputs", "outputs", "thresholds"] as const;

export interface RiskModel {
  id: string;
  risk_area: RiskArea;
  status: (typeof RISK_MODEL_STATUSES)[number];
  version: number;
  name: string;
  purpose: string;
  method: string;
  inputs: unknown[];
  outputs: unknown[];
  thresholds: unknown[];
  owner: { user_id: string; name: string | null } | null;
  validation: {
    last_validated_at: string | null;
    validated_by: { user_id: string; name: string | null } | null;
    outcome: (typeof RISK_MODEL_OUTCOMES)[number] | null;
    notes: string | null;
    next_validation_due: string | null;
    overdue: boolean;
  };
  retired: { at: string | null; by: string | null; reason: string | null } | null;
  health: ModelHealth;
  health_words: string;
  linked_risks: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const MODEL_HEALTH = ["healthy", "validation_overdue", "last_validation_failed", "no_validation_yet", "retired"] as const;
export type ModelHealth = (typeof MODEL_HEALTH)[number];
export const MODEL_HEALTH_WORDS: Record<ModelHealth, string> = {
  healthy: "Healthy",
  validation_overdue: "Validation overdue",
  last_validation_failed: "Last validation failed",
  no_validation_yet: "No validation yet",
  retired: "Retired",
};
/** A model's health: a failed last validation first, then an overdue one, then none at all. */
export function modelHealth(m: { status: string; outcome: string | null; overdue: boolean; last_validated_at: string | null }): ModelHealth {
  if (m.status === "retired") return "retired";
  if (m.outcome === "failed") return "last_validation_failed";
  if (m.overdue) return "validation_overdue";
  if (!m.last_validated_at) return "no_validation_yet";
  return "healthy";
}

const SELECT = `SELECT m.*, v.name, v.purpose, v.method, v.inputs, v.outputs, v.thresholds, o.name AS owner_name, vb.name AS validated_by_name,
  (SELECT count(*)::int FROM ${T}.risk_links l WHERE l.target_type = 'risk_model' AND l.target_id = m.id::text) AS linked_risks
  FROM ${T}.risk_models m JOIN ${T}.risk_model_versions v ON v.model_id = m.id AND v.version = m.version
  LEFT JOIN ${T}.users o ON o.id = m.owner_user_id LEFT JOIN ${T}.users vb ON vb.id = m.validated_by`;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const toModel = (r: Row): RiskModel => {
  const status = r.status as RiskModel["status"];
  const due = day(r.next_validation_due);
  const overdue = Boolean(due && status !== "retired" && due < today());
  const health = modelHealth({ status, outcome: (r.validation_outcome as string | null) ?? null, overdue, last_validated_at: iso(r.last_validated_at) });
  return {
    health,
    health_words: MODEL_HEALTH_WORDS[health],
    linked_risks: Number(r.linked_risks ?? 0),
    id: r.id as string,
    risk_area: r.risk_area as RiskArea,
    status,
    version: Number(r.version),
    name: r.name as string,
    purpose: r.purpose as string,
    method: r.method as string,
    inputs: arr(r.inputs),
    outputs: arr(r.outputs),
    thresholds: arr(r.thresholds),
    owner: r.owner_user_id ? { user_id: r.owner_user_id as string, name: (r.owner_name as string | null) ?? null } : null,
    validation: {
      last_validated_at: iso(r.last_validated_at),
      validated_by: r.validated_by ? { user_id: r.validated_by as string, name: (r.validated_by_name as string | null) ?? null } : null,
      outcome: (r.validation_outcome as RiskModel["validation"]["outcome"]) ?? null,
      notes: (r.validation_notes as string | null) ?? null,
      next_validation_due: due,
      overdue,
    },
    retired: status === "retired" ? { at: iso(r.retired_at), by: (r.retired_by as string | null) ?? null, reason: (r.retire_reason as string | null) ?? null } : null,
    created_by: (r.created_by as string | null) ?? null,
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
  };
};

async function getModel(db: Db, id: string): Promise<RiskModel | undefined> {
  if (!UUID.safeParse(id).success) return undefined;
  const r = (await db.query(`${SELECT} WHERE m.id = $1`, [id])).rows[0];
  return r ? toModel(r) : undefined;
}

/** Risk models past their next validation date and not retired, for ops_status. */
export async function overdueRiskModelValidations(db: Db): Promise<{ count: number; models: { id: string; name: string; risk_area: string; next_validation_due: string | null }[] }> {
  const where = `m.status <> 'retired' AND m.next_validation_due < current_date`;
  const { rows } = await db.query(
    `SELECT m.id, m.risk_area, m.next_validation_due, v.name FROM ${T}.risk_models m JOIN ${T}.risk_model_versions v ON v.model_id = m.id AND v.version = m.version WHERE ${where} ORDER BY m.next_validation_due LIMIT 20`,
  );
  const n = Number((await db.query(`SELECT count(*)::int AS n FROM ${T}.risk_models m WHERE ${where}`)).rows[0]?.n ?? 0);
  return { count: n, models: rows.map((r) => ({ id: r.id as string, name: r.name as string, risk_area: r.risk_area as string, next_validation_due: day(r.next_validation_due) })) };
}

/** Mynt's risk models that aren't retired and aren't healthy, for ops_status. */
export async function unhealthyRiskModels(db: Db): Promise<{ count: number; models: { id: string; name: string; risk_area: string; health: ModelHealth; health_words: string }[] }> {
  const models = (await db.query(`${SELECT} WHERE m.status <> 'retired' ORDER BY m.created_at, m.id`)).rows.map(toModel).filter((m) => m.health !== "healthy");
  return { count: models.length, models: models.slice(0, 20).map((m) => ({ id: m.id, name: m.name, risk_area: m.risk_area, health: m.health, health_words: m.health_words })) };
}

const PURPOSES = ["pd_scorecard", "affordability", "fraud_score", "behaviour_score", "lgd", "fx_risk", "aml_risk", "other"] as const;

export function registerRiskModelTools(server: McpServer, store: Store, user: User) {
  // Mynt admins only, read again from the store each call (a role taken away ends it at once).
  const isAdmin = async () => {
    const u = await store.getUser(user.id);
    return Boolean(u && effectiveRoles(u.roles).includes("admin"));
  };
  const NOT_ADMIN = "Only Mynt's admins keep and read Mynt's risk models";
  const ownerOk = async (id: string) => id === user.id || Boolean((await store.getUser(id))?.roles.includes("admin"));
  const futureDay = (d: string) => d > today();

  server.registerTool(
    "add_risk_model",
    {
      title: "Add a risk model",
      description:
        "Admin: add one of Mynt's own risk models, in one of the platform's risk areas (financial, compliance, third_party, operations, business_process, technology, regulated_product): its name, purpose, method (the formula or approach, in words), inputs ({ name, description?, source? }), outputs (the scores or measures it produces: { name, description? }) and thresholds ({ name, value, meaning? }), its owner (a Mynt admin; you by default), its status (draft by default, or active) and when its first validation is due. It starts at version 1. Audited.",
      inputSchema: {
        risk_area: z.enum(RISK_AREAS),
        name: DEFINITION.name,
        purpose: DEFINITION.purpose,
        method: DEFINITION.method,
        inputs: DEFINITION.inputs.default([]),
        outputs: DEFINITION.outputs.default([]),
        thresholds: DEFINITION.thresholds.default([]),
        owner_user_id: UUID.optional(),
        status: z.enum(["draft", "active"]).default("draft"),
        next_validation_due: DATE.optional().describe("When its validation is due (a future date)"),
      },
    },
    async ({ risk_area, name, purpose, method, inputs, outputs, thresholds, owner_user_id, status, next_validation_due }) => {
      if (!(await isAdmin())) return fail(NOT_ADMIN);
      const owner = owner_user_id ?? user.id;
      if (!(await ownerOk(owner))) return fail("The model's owner must be a Mynt admin");
      if (next_validation_due && !futureDay(next_validation_due)) return fail("next_validation_due must be a date after today");
      const id = randomUUID();
      await store.db.query(`INSERT INTO ${T}.risk_models (id, risk_area, status, version, owner_user_id, next_validation_due, created_by) VALUES ($1, $2, $3, 1, $4, $5, $6)`, [
        id,
        risk_area,
        status,
        owner,
        next_validation_due ?? null,
        user.id,
      ]);
      await store.db.query(
        `INSERT INTO ${T}.risk_model_versions (model_id, version, name, purpose, method, inputs, outputs, thresholds, created_by) VALUES ($1, 1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)`,
        [id, name, purpose, method, JSON.stringify(inputs), JSON.stringify(outputs), JSON.stringify(thresholds), user.id],
      );
      const model = (await getModel(store.db, id))!;
      await store.audit(user.id, "add_risk_model", id, { platform: true, risk_area, name, status, version: 1, owner_user_id: owner, next_validation_due: next_validation_due ?? null });
      return json({ model });
    },
  );

  server.registerTool(
    "update_risk_model",
    {
      title: "Edit a risk model",
      description:
        "Admin: change one of Mynt's risk models (not a retired one). A change to what it is (name, purpose, method, inputs, outputs, thresholds) adds a new version with the rest carried over, and the old version stays as it was (list_risk_models with model_id shows them all); its owner (a Mynt admin), status (draft or active) and next validation date change on the model itself. Only what you pass changes; note says why. Audited, with what changed.",
      inputSchema: {
        model_id: UUID,
        name: DEFINITION.name.optional(),
        purpose: DEFINITION.purpose.optional(),
        method: DEFINITION.method.optional(),
        inputs: DEFINITION.inputs.optional(),
        outputs: DEFINITION.outputs.optional(),
        thresholds: DEFINITION.thresholds.optional(),
        owner_user_id: UUID.optional(),
        status: z.enum(["draft", "active"]).optional(),
        next_validation_due: DATE.optional(),
        note: z.string().trim().max(2000).optional().describe("Why it changed"),
      },
    },
    async (args) => {
      if (!(await isAdmin())) return fail(NOT_ADMIN);
      const before = await getModel(store.db, args.model_id);
      if (!before) return fail(`No risk model '${args.model_id}'`);
      if (before.status === "retired") return fail("This model is retired: it can't be changed");
      if (args.owner_user_id && !(await ownerOk(args.owner_user_id))) return fail("The model's owner must be a Mynt admin");
      if (args.next_validation_due && !futureDay(args.next_validation_due)) return fail("next_validation_due must be a date after today");
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      const defChanges = DEFINITION_KEYS.filter((k) => args[k] !== undefined && !same(args[k], before[k]));
      const was: Record<string, unknown> = { owner_user_id: before.owner?.user_id ?? null, status: before.status, next_validation_due: before.validation.next_validation_due };
      const modelChanges = (["owner_user_id", "status", "next_validation_due"] as const).filter((k) => args[k] !== undefined && args[k] !== was[k]);
      if (!defChanges.length && !modelChanges.length) return fail("Nothing to change: pass what's different");
      let version = before.version;
      if (defChanges.length) {
        version += 1;
        const next = Object.fromEntries(DEFINITION_KEYS.map((k) => [k, args[k] ?? before[k]])) as unknown as Definition;
        await store.db.query(
          `INSERT INTO ${T}.risk_model_versions (model_id, version, name, purpose, method, inputs, outputs, thresholds, change_note, created_by) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)`,
          [before.id, version, next.name, next.purpose, next.method, JSON.stringify(next.inputs), JSON.stringify(next.outputs), JSON.stringify(next.thresholds), args.note ?? null, user.id],
        );
      }
      const sets = [`version = $2`, ...modelChanges.map((k, i) => `${k} = $${i + 3}`), "updated_at = now()"];
      await store.db.query(`UPDATE ${T}.risk_models SET ${sets.join(", ")} WHERE id = $1`, [before.id, version, ...modelChanges.map((k) => args[k])]);
      const model = (await getModel(store.db, before.id))!;
      const changes = Object.fromEntries([
        ...defChanges.map((k) => [k, k === "name" ? { from: before.name, to: args.name } : { changed: true }]),
        ...modelChanges.map((k) => [k, { from: was[k], to: args[k] }]),
      ]);
      await store.audit(user.id, "update_risk_model", before.id, { platform: true, risk_area: model.risk_area, name: model.name, version, new_version: defChanges.length > 0, changes, note: args.note ?? null });
      return json({ model, new_version: defChanges.length > 0, changed: [...defChanges, ...modelChanges] });
    },
  );

  server.registerTool(
    "validate_risk_model",
    {
      title: "Record a risk model's validation",
      description:
        "Admin: record a validation of one of Mynt's risk models (not a retired one), of its current version: the outcome (passed, passed_with_findings, failed), notes (what was checked and found) and when the next validation is due (a future date). It becomes the model's last validation; every one is kept (list_risk_models with model_id). A failed validation doesn't change the model's status: change it with update_risk_model or retire it. Audited.",
      inputSchema: {
        model_id: UUID,
        outcome: z.enum(RISK_MODEL_OUTCOMES),
        notes: z.string().trim().min(3).max(4000),
        next_validation_due: DATE,
      },
    },
    async ({ model_id, outcome, notes, next_validation_due }) => {
      if (!(await isAdmin())) return fail(NOT_ADMIN);
      const before = await getModel(store.db, model_id);
      if (!before) return fail(`No risk model '${model_id}'`);
      if (before.status === "retired") return fail("This model is retired: it isn't validated any more");
      if (!futureDay(next_validation_due)) return fail("next_validation_due must be a date after today");
      const id = randomUUID();
      await store.db.query(`INSERT INTO ${T}.risk_model_validations (id, model_id, version, outcome, notes, next_validation_due, validated_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
        id,
        model_id,
        before.version,
        outcome,
        notes,
        next_validation_due,
        user.id,
      ]);
      await store.db.query(
        `UPDATE ${T}.risk_models SET last_validated_at = now(), validated_by = $2, validation_outcome = $3, validation_notes = $4, next_validation_due = $5, updated_at = now() WHERE id = $1`,
        [model_id, user.id, outcome, notes, next_validation_due],
      );
      const model = (await getModel(store.db, model_id))!;
      await store.audit(user.id, "validate_risk_model", model_id, { platform: true, risk_area: model.risk_area, name: model.name, version: before.version, outcome, next_validation_due, validation_id: id });
      return json({ model, validation: { id, version: before.version, outcome, notes, next_validation_due } });
    },
  );

  server.registerTool(
    "retire_risk_model",
    {
      title: "Retire a risk model",
      description:
        "Admin: retire one of Mynt's risk models, saying why. It stays listed, with its versions and validations, but can't be changed or validated again, and is never overdue. Audited.",
      inputSchema: { model_id: UUID, reason: z.string().trim().min(3).max(2000) },
    },
    async ({ model_id, reason }) => {
      if (!(await isAdmin())) return fail(NOT_ADMIN);
      const before = await getModel(store.db, model_id);
      if (!before) return fail(`No risk model '${model_id}'`);
      if (before.status === "retired") return fail("This model is already retired");
      await store.db.query(`UPDATE ${T}.risk_models SET status = 'retired', retired_at = now(), retired_by = $2, retire_reason = $3, updated_at = now() WHERE id = $1`, [model_id, user.id, reason]);
      const model = (await getModel(store.db, model_id))!;
      await store.audit(user.id, "retire_risk_model", model_id, { platform: true, risk_area: model.risk_area, name: model.name, version: model.version, from_status: before.status, reason });
      return json({ model });
    },
  );

  server.registerTool(
    "list_risk_models",
    {
      title: "Mynt's risk models",
      description:
        "Admin: Mynt's own risk models, each with its risk area, status (draft, active, retired), current version and definition (name, purpose, method, inputs, outputs, thresholds), owner, and validation (the last one: when, by whom, outcome, notes; the next due date, and whether it's overdue), its health in words (Healthy, Validation overdue, Last validation failed, No validation yet; Retired for a retired one) and how many risks link to it (linked_risks), newest first, with counts by status, how many are overdue and how many aren't healthy. Filter by risk_area or status. With model_id: that model with every version (oldest first), every validation (newest first) and the risks linked to it (linked: each risk with its source, residual score, status and review date; link one with link_risk, target_type risk_model).",
      inputSchema: {
        risk_area: z.enum(RISK_AREAS).optional(),
        status: z.enum(RISK_MODEL_STATUSES).optional(),
        model_id: UUID.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ risk_area, status, model_id }) => {
      if (!(await isAdmin())) return fail(NOT_ADMIN);
      if (model_id) {
        const model = await getModel(store.db, model_id);
        if (!model) return fail(`No risk model '${model_id}'`);
        const versions = (
          await store.db.query(
            `SELECT v.*, u.name AS author FROM ${T}.risk_model_versions v LEFT JOIN ${T}.users u ON u.id = v.created_by WHERE v.model_id = $1 ORDER BY v.version`,
            [model_id],
          )
        ).rows.map((v) => ({
          version: Number(v.version),
          name: v.name as string,
          purpose: v.purpose as string,
          method: v.method as string,
          inputs: arr(v.inputs),
          outputs: arr(v.outputs),
          thresholds: arr(v.thresholds),
          change_note: (v.change_note as string | null) ?? null,
          created_by: v.created_by ? { user_id: v.created_by as string, name: (v.author as string | null) ?? null } : null,
          created_at: iso(v.created_at),
        }));
        const validations = (
          await store.db.query(
            `SELECT x.*, u.name AS validator FROM ${T}.risk_model_validations x LEFT JOIN ${T}.users u ON u.id = x.validated_by WHERE x.model_id = $1 ORDER BY x.validated_at DESC, x.id`,
            [model_id],
          )
        ).rows.map((x) => ({
          id: x.id as string,
          version: Number(x.version),
          outcome: x.outcome as string,
          notes: x.notes as string,
          next_validation_due: day(x.next_validation_due),
          validated_by: x.validated_by ? { user_id: x.validated_by as string, name: (x.validator as string | null) ?? null } : null,
          validated_at: iso(x.validated_at),
        }));
        return json({ model, versions, validations, linked: await risksLinkedToModel(store, model_id) });
      }
      const { rows } = await store.db.query(`${SELECT} WHERE ($1::text IS NULL OR m.risk_area = $1) AND ($2::text IS NULL OR m.status = $2) ORDER BY m.created_at DESC, m.id LIMIT 500`, [
        risk_area ?? null,
        status ?? null,
      ]);
      const models = rows.map(toModel);
      const all = (await store.db.query(`${SELECT} WHERE ($1::text IS NULL OR m.risk_area = $1)`, [risk_area ?? null])).rows.map(toModel);
      const counts = Object.fromEntries(RISK_MODEL_STATUSES.map((s) => [s, all.filter((r) => r.status === s).length])) as Record<string, number>;
      counts.overdue = all.filter((r) => r.validation.overdue).length;
      counts.not_healthy = all.filter((r) => r.health !== "healthy" && r.health !== "retired").length;
      return json({ models, counts });
    },
  );

  server.registerTool(
    "admin_list_product_risk_models",
    {
      title: "Financial products' own risk models",
      description:
        "Admin: the risk models financial products declare in their own definitions (the product definition's risk_models: each with its _id, model_name, purpose such as pd_scorecard or fraud_score, version and description), across every firm, each with its product (id, name, status) and the firm that owns it (none: one of Mynt's reference products). Products without a definition, or whose definition declares none, aren't listed. Read-only.",
      inputSchema: { query: z.string().trim().max(200).optional().describe("Matches the product's name or id, or the firm's name"), limit: z.number().int().min(1).max(500).default(200) },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      if (!(await isAdmin())) return fail(NOT_ADMIN);
      const like = query ? `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const { rows } = await store.db.query(
        `SELECT p.id, p.data->>'name' AS name, p.status, p.archived_at, p.definition->'risk_models' AS models, e.id::text AS entity_id, e.name AS entity_name
           FROM ${T}.products p LEFT JOIN ${T}.entities e ON e.id = p.entity_id
          WHERE jsonb_typeof(p.definition->'risk_models') = 'array' AND jsonb_array_length(p.definition->'risk_models') > 0
            AND ($1::text IS NULL OR p.data->>'name' ILIKE $1 OR e.name ILIKE $1 OR p.id = $2)
          ORDER BY p.data->>'name', p.id LIMIT $3`,
        [like, query ?? null, limit],
      );
      const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
      const models = rows.flatMap((r) =>
        arr(r.models)
          .filter((m): m is Row => typeof m === "object" && m !== null)
          .map((m) => ({
            product: { id: r.id as string, name: (r.name as string | null) ?? (r.id as string), status: r.status as string, archived: r.archived_at != null },
            firm: r.entity_id ? { id: r.entity_id as string, name: r.entity_name as string } : null,
            model: { id: str(m._id), name: str(m.model_name), purpose: (PURPOSES as readonly string[]).includes(m.purpose as string) ? (m.purpose as string) : str(m.purpose), version: str(m.version), description: str(m.description) },
          })),
      );
      return json({ models, products: rows.length });
    },
  );
}
