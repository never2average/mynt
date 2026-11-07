import { z } from "zod";
import { UNDERLYINGS, WRAPPERS } from "./catalog.js";
import {
  ControlTemplateSchema,
  FilingSchema,
  InspectionEventTemplateSchema,
  InspectionRecordTemplateSchema,
  ObligationSchema,
  PolicyTemplateSchema,
  RiskModelTemplateSchema,
  RiskSchema,
  fieldKeyDupes,
  type FieldDef,
} from "./grc.js";

// A region's regulatory model: its regulators (what each supervises, the licences it grants and the
// GRC each licence carries) and the legal instruments those rest on.

const Id = z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/, "Use a lowercase id like 'rbi' or 'nbfc_icc'");
const Qualification = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .default({})
  .describe("Criteria as key/value pairs, e.g. { min_net_worth_inr: 50000000, resident: true }");
// One action or several; stored as a list.
const actions = <T extends z.ZodTypeAny>(item: T) =>
  z.union([item, z.array(item).min(1)]).transform((v) => (Array.isArray(v) ? v : [v]) as z.infer<T>[]);

// What can be done with a regulated product type. assessment is producing an independent rating,
// valuation, index, actuarial certification, audit or accreditation of it.
export const PRODUCT_ACTIONS = [
  "issuance",
  "sale",
  "purchase",
  "secondary_sale",
  "repackaging",
  "advice",
  "servicing",
  "underwriting",
  "assessment",
] as const;
const ProductAction = z.enum(PRODUCT_ACTIONS);

// Regulated product types are a region-wide catalogue of their own, not part of any one regulator:
// a product type (e.g. a sovereign gold bond) may be supervised by several regulators, and each
// regulator maps the product types it supervises, many to many.
export const RegulatedProductTypeSchema = z.object({
  id: Id,
  name: z.string().min(1),
  description: z.string().default(""),
  type_id: z.string().describe("The Mynt product category this maps to (see list_product_categories)"),
  actions: actions(ProductAction).describe("Every action that can be taken on this product type"),
  underlying: z.enum(UNDERLYINGS).optional().describe("What it is made of: cash, securities, commodities, real_assets, receivables, risk, data or digital_assets"),
  wrapper: z.enum(WRAPPERS).optional().describe("A statutory or tax structure around it: statutory_pension, tax_advantaged or government_scheme"),
});

// A regulator's mapping onto a catalogue product type, with the actions it supervises.
const SupervisedProduct = z.object({
  id: z.string().describe("A regulated product type id in this region (see list_regulated_product_types)"),
  actions: actions(ProductAction)
    .optional()
    .describe("The actions this regulator supervises; a subset of the product type's actions. Omit for all of them."),
});

// What a licence grants on one of its regulator's product types. A bare id grants every action the
// regulator supervises on it.
const ProductGrant = z.union([
  z.string().transform((id) => ({ id, actions: undefined as (typeof PRODUCT_ACTIONS)[number][] | undefined })),
  z.object({
    id: z.string(),
    actions: actions(ProductAction)
      .optional()
      .describe("The actions this licence permits; a subset of what the regulator supervises. Omit for all of them."),
  }),
]);

const Persona = z.object({
  id: Id,
  name: z.string().min(1),
  description: z.string().default(""),
  qualification: Qualification,
  action: actions(z.string().regex(/^[a-z][a-z0-9_]*$/)).describe("e.g. onboarding, identity_validation, deposit_custody"),
});

const Stakeholder = Persona.extend({
  obligations: z.array(z.string()).default([]).describe("Obligation ids from this licence's register, or short descriptions"),
});

// Data repositories: things the regulator has published or done.
const RepoItem = z.object({
  title: z.string().min(1),
  date: z.string().optional(),
  url: z.string().url().optional(),
  summary: z.string().default(""),
});

const LicenseType = z.object({
  _id: Id,
  name: z.string().min(1),
  scope: z.string().default(""),
  application_procedure: z.array(z.string().min(1)).default([]).describe("How to obtain the licence, in order"),
  grc: z.object({
    // Obligations, filings and risks are data; controls and inspection events are templates.
    registers: z
      .object({
        obligations: z.array(ObligationSchema).default([]),
        reporting_disclosure_filings: z.array(FilingSchema).default([]),
        risks: z.array(RiskSchema).default([]),
        controls: z.array(ControlTemplateSchema).default([]),
        inspection_events: z.array(InspectionEventTemplateSchema).default([]),
      })
      .default({ obligations: [], reporting_disclosure_filings: [], risks: [], controls: [], inspection_events: [] }),
    // Communications, enforcement actions and press releases are data; policies, risk models and
    // inspection history are templates.
    repositories: z
      .object({
        regulatory_communications: z.array(RepoItem).default([]),
        enforcement_actions: z.array(RepoItem).default([]),
        press_releases: z.array(RepoItem).default([]),
        policies: z.array(PolicyTemplateSchema).default([]),
        risk_models: z.array(RiskModelTemplateSchema).default([]),
        inspection_history: z.array(InspectionRecordTemplateSchema).default([]),
      })
      .default({
        regulatory_communications: [],
        enforcement_actions: [],
        press_releases: [],
        policies: [],
        risk_models: [],
        inspection_history: [],
      }),
    allowed_product_types: z
      .array(ProductGrant)
      .default([])
      .describe("Product types from this regulator's scope.product_types, each with the actions this licence permits"),
    allowed_customer_segments: z.array(z.string()).default([]).describe("Ids from this regulator's scope.customer_personas"),
    mandatory_stakeholders: z
      .object({ internal: z.array(Stakeholder).default([]), external: z.array(Stakeholder).default([]) })
      .default({ internal: [], external: [] }),
  }),
});

export const RegulatorSchema = z.object({
  id: Id,
  name: z.string().min(1),
  short_name: z.string().optional().describe("How products cite it, e.g. RBI"),
  scope: z
    .object({
      product_types: z
        .array(SupervisedProduct)
        .default([])
        .describe("Regulated product types this regulator supervises; define them first with define_regulated_product_type"),
      customer_personas: z.array(Persona).default([]).describe("Ids must start with '<regulator id>_'"),
    })
    .default({ product_types: [], customer_personas: [] }),
  license_types: z.array(LicenseType).default([]).describe("Licence _ids must start with '<regulator id>_'"),
});

// ---- legal: split into the legislative branch (what the law says) and the judiciary (how courts
// have read it). Obligations and filings cite either by id through legal_ref.

const AppliesTo = z
  .object({
    regulators: z.array(z.string()).default([]),
    license_types: z.array(z.string()).default([]),
    product_types: z.array(z.string()).default([]),
    customer_personas: z.array(z.string()).default([]),
  })
  .default({ regulators: [], license_types: [], product_types: [], customer_personas: [] });

export const LEGISLATIVE_KINDS = [
  "act",
  "ordinance",
  "rule",
  "regulation",
  "master_direction",
  "circular",
  "guideline",
  "notification",
  "order",
] as const;

export const LegislativeSchema = z.object({
  id: Id,
  title: z.string().min(1),
  kind: z.enum(LEGISLATIVE_KINDS),
  citation: z.string().optional().describe("e.g. 'Act No. 2 of 1934' or a circular number"),
  issued_by: z.string().optional().describe("Regulator id, or the legislature (e.g. parliament)"),
  parent_id: z.string().optional().describe("The legislative id this is made under, e.g. the act a rule or direction derives from"),
  effective_from: z.string().optional(),
  status: z.enum(["in_force", "amended", "repealed", "draft"]).default("in_force"),
  url: z.string().url().optional(),
  summary: z.string().default(""),
  applies_to: AppliesTo,
});

export const COURT_LEVELS = ["supreme_court", "high_court", "tribunal", "appellate_authority", "other"] as const;

export const JudgmentSchema = z.object({
  id: Id,
  title: z.string().min(1).describe("Case name, e.g. 'X v. Union of India'"),
  court: z.string().min(1).describe("e.g. Supreme Court of India, Securities Appellate Tribunal"),
  court_level: z.enum(COURT_LEVELS),
  citation: z.string().optional().describe("e.g. a law-report citation or case number"),
  decided_on: z.string().optional(),
  bench: z.array(z.string()).default([]),
  holding: z.string().default("").describe("The legal principle the court decided"),
  summary: z.string().default(""),
  interprets: z.array(z.string()).default([]).describe("Legislative ids this judgment construes"),
  status: z.enum(["good_law", "overruled", "distinguished", "stayed", "under_appeal"]).default("good_law"),
  url: z.string().url().optional(),
  applies_to: AppliesTo,
});

// The earlier single-list shape, still accepted by the deprecated define_legal_instrument tool.
export const LegacyLegalSchema = LegislativeSchema.extend({ kind: z.enum([...LEGISLATIVE_KINDS, "judgment"]) }).omit({ status: true, parent_id: true });

export type ProductAction = (typeof PRODUCT_ACTIONS)[number];
export type RegulatedProductType = z.infer<typeof RegulatedProductTypeSchema>;
// A regulator as admins define it and as it is stored: its scope only references product types.
export type RegulatorInput = z.infer<typeof RegulatorSchema>;
type InputLicense = RegulatorInput["license_types"][number];

// One row of the regulator <-> product type mapping.
export interface ProductMapping {
  regulator_id: string;
  product_type_id: string;
  actions: ProductAction[];
}

// A regulator as read: each supervised product type carries its catalogue entry and the actions the
// regulator supervises, and each licence grant names the actions it permits.
export interface SupervisedProductType {
  id: string;
  name: string;
  description: string;
  type_id: string;
  action: ProductAction[];
}
export type License = Omit<InputLicense, "grc"> & {
  grc: Omit<InputLicense["grc"], "allowed_product_types"> & { allowed_product_types: { id: string; actions: ProductAction[] }[] };
};
export type Regulator = Omit<RegulatorInput, "scope" | "license_types"> & {
  scope: { product_types: SupervisedProductType[]; customer_personas: RegulatorInput["scope"]["customer_personas"] };
  license_types: License[];
};
export type Legislation = z.infer<typeof LegislativeSchema>;
export type Judgment = z.infer<typeof JudgmentSchema>;
export interface LegalModel {
  legislative: Legislation[];
  judiciary: Judgment[];
}
export interface RegulatoryModel {
  regulators: Regulator[];
  legal: LegalModel;
}
export const EMPTY_MODEL: RegulatoryModel = { regulators: [], legal: { legislative: [], judiciary: [] } };

// Accepts what is stored, including the earlier flat legal list, and returns the split shape.
export function normalizeModel(raw: unknown): RegulatoryModel {
  const m = (raw ?? {}) as { regulators?: Regulator[]; legal?: unknown };
  const legal = m.legal;
  if (Array.isArray(legal)) {
    const items = legal as (Omit<Legislation, "kind"> & { kind: string })[];
    return {
      regulators: liftRegulators(m.regulators),
      legal: {
        legislative: items.filter((l) => l.kind !== "judgment") as Legislation[],
        judiciary: items.filter((l) => l.kind === "judgment").map(legacyToJudgment),
      },
    };
  }
  const l = (legal ?? {}) as Partial<LegalModel>;
  return { regulators: liftRegulators(m.regulators), legal: { legislative: l.legislative ?? [], judiciary: l.judiciary ?? [] } };
}

// The store hydrates regulators before handing them out (see hydrateRegulators); anything else is
// passed through so a stored model still reads.
function liftRegulators(raw: unknown): Regulator[] {
  return ((raw as Regulator[]) ?? []).map((r) => ({
    ...r,
    scope: { product_types: r.scope?.product_types ?? [], customer_personas: r.scope?.customer_personas ?? [] },
    license_types: r.license_types ?? [],
  }));
}

// Joins stored regulators with the region's product catalogue and mapping rows. Grants that name a
// bare id take every action the regulator supervises on that product type.
export function hydrateRegulators(stored: unknown[], catalogue: RegulatedProductType[], mappings: ProductMapping[]): Regulator[] {
  const byId = new Map(catalogue.map((p) => [p.id, p]));
  return stored.map((raw) => {
    const parsed = RegulatorSchema.safeParse(stripScopeProducts(raw));
    const r = (parsed.success ? parsed.data : raw) as RegulatorInput;
    const supervised: SupervisedProductType[] = mappings
      .filter((m) => m.regulator_id === r.id && byId.has(m.product_type_id))
      .map((m) => {
        const p = byId.get(m.product_type_id)!;
        return { id: p.id, name: p.name, description: p.description, type_id: p.type_id, action: m.actions };
      });
    const supervisedActions = new Map(supervised.map((p) => [p.id, p.action]));
    return {
      ...r,
      scope: { product_types: supervised, customer_personas: r.scope?.customer_personas ?? [] },
      license_types: (r.license_types ?? []).map((l) => ({
        ...l,
        grc: {
          ...l.grc,
          allowed_product_types: (l.grc.allowed_product_types ?? []).map((g) =>
            typeof g === "string"
              ? { id: g, actions: supervisedActions.get(g) ?? [] }
              : { id: g.id, actions: g.actions ?? supervisedActions.get(g.id) ?? [] },
          ),
        },
      })),
    };
  });
}

// Stored regulators keep only their mapping elsewhere, so drop any product types left in the JSON.
export function stripScopeProducts(r: unknown) {
  const reg = r as { scope?: Record<string, unknown> };
  return { ...reg, scope: { ...(reg.scope ?? {}), product_types: [] } };
}

// What define_regulator persists: the regulator's JSON without product types, plus its mapping rows
// with omitted actions resolved against the catalogue.
export function splitRegulator(r: RegulatorInput, catalogue: RegulatedProductType[]): { stored: unknown; mappings: ProductMapping[] } {
  const byId = new Map(catalogue.map((p) => [p.id, p]));
  return {
    stored: stripScopeProducts(r),
    mappings: r.scope.product_types.map((s) => ({
      regulator_id: r.id,
      product_type_id: s.id,
      actions: (s.actions ?? byId.get(s.id)?.actions ?? []) as ProductAction[],
    })),
  };
}

export function legacyToJudgment(l: { id: string; title: string; issued_by?: string; citation?: string; effective_from?: string; url?: string; summary?: string; applies_to?: Judgment["applies_to"] }): Judgment {
  return {
    id: l.id,
    title: l.title,
    court: l.issued_by ?? "Verify: court not recorded",
    court_level: "other",
    citation: l.citation,
    decided_on: l.effective_from,
    bench: [],
    holding: "",
    summary: l.summary ?? "",
    interprets: [],
    status: "good_law",
    url: l.url,
    applies_to: l.applies_to ?? { regulators: [], license_types: [], product_types: [], customer_personas: [] },
  };
}

export const legalIds = (m: RegulatoryModel) => [...m.legal.legislative.map((l) => l.id), ...m.legal.judiciary.map((j) => j.id)];

const dupes = (ids: string[]) => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];

// Errors break the regulator's own links and block the write; warnings point outside it.
// Regulated product types are checked on their own: their category must be a Mynt category.
export function validateProductType(p: RegulatedProductType, ctx: { categories: string[] }): string[] {
  return ctx.categories.includes(p.type_id) ? [] : [`product type '${p.id}' maps to '${p.type_id}', which isn't an active Mynt product category`];
}

const subset = (inner: readonly string[], outer: readonly string[]) => inner.filter((a) => !outer.includes(a));

export function validateRegulator(
  r: RegulatorInput,
  ctx: { legalIds: string[]; productTypes: RegulatedProductType[]; otherRegulators: Regulator[] },
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const catalogue = new Map(ctx.productTypes.map((p) => [p.id, p]));
  const productIds = r.scope.product_types.map((p) => p.id);
  const personaIds = r.scope.customer_personas.map((p) => p.id);
  const licenseIds = r.license_types.map((l) => l._id);
  for (const d of dupes(productIds)) errors.push(`supervises product type '${d}' twice`);
  for (const d of dupes(personaIds)) errors.push(`duplicate persona id '${d}'`);
  for (const d of dupes(licenseIds)) errors.push(`duplicate licence id '${d}'`);

  // Personas and licences belong to one regulator: prefixed with its id and unique in the region.
  const prefix = `${r.id}_`;
  for (const id of personaIds) if (!id.startsWith(prefix)) errors.push(`persona id '${id}' must start with '${prefix}'`);
  for (const id of licenseIds) if (!id.startsWith(prefix)) errors.push(`licence id '${id}' must start with '${prefix}'`);
  for (const other of ctx.otherRegulators) {
    if (other.id === r.id) continue;
    for (const id of personaIds) if (other.scope.customer_personas.some((p) => p.id === id)) errors.push(`persona id '${id}' is already used by ${other.id}`);
    for (const id of licenseIds) if (other.license_types.some((l) => l._id === id)) errors.push(`licence id '${id}' is already used by ${other.id}`);
  }

  // Product types come from the region's catalogue; a regulator supervises some of their actions.
  const supervised = new Map<string, readonly string[]>();
  for (const s of r.scope.product_types) {
    const p = catalogue.get(s.id);
    if (!p) {
      errors.push(`supervises product type '${s.id}', which isn't a regulated product type in this region (define_regulated_product_type)`);
      continue;
    }
    const extra = subset(s.actions ?? [], p.actions);
    if (extra.length) errors.push(`supervises '${extra.join(", ")}' on '${s.id}', which the product type doesn't allow (${p.actions.join(", ")})`);
    supervised.set(s.id, s.actions ?? p.actions);
  }

  for (const l of r.license_types) {
    const where = `licence '${l._id}'`;
    for (const d of dupes(l.grc.allowed_product_types.map((g) => g.id))) errors.push(`${where} grants product type '${d}' twice`);
    for (const g of l.grc.allowed_product_types) {
      const allowed = supervised.get(g.id);
      if (!allowed) {
        errors.push(`${where} allows product type '${g.id}', which ${r.id} doesn't supervise`);
        continue;
      }
      const extra = subset(g.actions ?? [], allowed);
      if (extra.length) errors.push(`${where} grants '${extra.join(", ")}' on '${g.id}', beyond what ${r.id} supervises (${allowed.join(", ")})`);
    }
    for (const id of l.grc.allowed_customer_segments) if (!personaIds.includes(id)) errors.push(`${where} allows segment '${id}', which ${r.id} doesn't define`);
    const reg = l.grc.registers;
    const repo = l.grc.repositories;
    const riskIds = reg.risks.map((x) => x.id);
    const obligationIds = reg.obligations.map((x) => x.id);
    const stakeholderIds = [...l.grc.mandatory_stakeholders.internal, ...l.grc.mandatory_stakeholders.external].map((s) => s.id);
    const notStakeholder = (what: string, id?: string) => {
      if (id && !stakeholderIds.includes(id)) warnings.push(`${where} ${what} names '${id}', which isn't a mandatory stakeholder`);
    };
    const cites = (what: string, ref?: string) => {
      if (ref && !ctx.legalIds.includes(ref)) warnings.push(`${where} ${what} cites '${ref}', which isn't recorded legislation or case law yet`);
    };

    for (const o of reg.obligations) {
      if (o.risk_ref && !riskIds.includes(o.risk_ref)) errors.push(`${where} obligation '${o.id}' points at unknown risk '${o.risk_ref}'`);
      notStakeholder(`obligation '${o.id}' owner`, o.owner);
      cites(`obligation '${o.id}'`, o.legal_ref);
    }
    for (const x of reg.reporting_disclosure_filings) {
      if (x.obligation_ref && !obligationIds.includes(x.obligation_ref)) errors.push(`${where} filing '${x.id}' points at unknown obligation '${x.obligation_ref}'`);
      cites(`filing '${x.id}'`, x.legal_ref);
    }
    for (const c of reg.controls) {
      for (const m of c.mitigates) if (!riskIds.includes(m)) errors.push(`${where} control '${c.id}' mitigates unknown risk '${m}'`);
      notStakeholder(`control '${c.id}' owner`, c.owner);
    }
    for (const t of repo.policies) notStakeholder(`policy '${t.id}' approver`, t.approved_by);

    const templates: [string, { id: string; legal_ref?: string; fields: FieldDef[] }[]][] = [
      ["controls", reg.controls],
      ["inspection_events", reg.inspection_events],
      ["policies", repo.policies],
      ["risk_models", repo.risk_models],
      ["inspection_history", repo.inspection_history],
    ];
    for (const [kind, list] of templates) {
      for (const t of list) {
        cites(`${kind} template '${t.id}'`, t.legal_ref);
        for (const k of fieldKeyDupes(t.fields)) errors.push(`${where} ${kind} template '${t.id}' repeats field '${k}'`);
        for (const fd of t.fields) cites(`${kind} template '${t.id}' field '${fd.key}'`, fd.legal_ref);
      }
    }

    const lists: [string, { id: string }[]][] = [
      ["obligations", reg.obligations],
      ["reporting_disclosure_filings", reg.reporting_disclosure_filings],
      ["risks", reg.risks],
      ...templates,
    ];
    for (const [kind, list] of lists) {
      for (const d of dupes(list.map((x) => x.id))) errors.push(`${where} has duplicate ${kind} id '${d}'`);
    }
  }
  return { errors, warnings };
}

// What a licence permits, product by product: the product type with the actions the licence grants.
export function licenseProducts(r: Regulator, l: License) {
  return l.grc.allowed_product_types.flatMap((g) => {
    const p = r.scope.product_types.find((x) => x.id === g.id);
    return p ? [{ ...p, action: g.actions }] : [];
  });
}

// Licences that let a firm do `action` with a product of `category` for `persona`, across regulators.
// Actions come from the licence's grant, not from everything its regulator supervises.
export function findLicenses(model: RegulatoryModel, q: { category?: string; action?: string; persona?: string; product_type?: string }) {
  const out = [];
  for (const r of model.regulators) {
    for (const l of r.license_types) {
      const products = licenseProducts(r, l).filter(
        (p) =>
          (!q.category || p.type_id === q.category) &&
          (!q.product_type || p.id === q.product_type) &&
          (!q.action || (p.action as string[]).includes(q.action)),
      );
      if ((q.category || q.action || q.product_type) && products.length === 0) continue;
      const segments = r.scope.customer_personas.filter((p) => l.grc.allowed_customer_segments.includes(p.id));
      if (q.persona && !segments.some((s) => s.id === q.persona)) continue;
      out.push({
        regulator: { id: r.id, name: r.name },
        license: { _id: l._id, name: l.name, scope: l.scope },
        product_types: products.map((p) => ({ id: p.id, name: p.name, type_id: p.type_id, action: p.action })),
        customer_segments: segments.map((s) => ({ id: s.id, name: s.name, qualification: s.qualification })),
        application_procedure: l.application_procedure,
        mandatory_stakeholders: {
          internal: l.grc.mandatory_stakeholders.internal.map((s) => s.name),
          external: l.grc.mandatory_stakeholders.external.map((s) => s.name),
        },
        obligations: l.grc.registers.obligations.length,
        filings: l.grc.registers.reporting_disclosure_filings.map((f) => ({ name: f.name, frequency: f.frequency, due: f.due })),
      });
    }
  }
  return out;
}

export function summarizeModel(model: RegulatoryModel) {
  return {
    regulators: model.regulators.map((r) => ({
      id: r.id,
      name: r.name,
      short_name: r.short_name,
      product_types: r.scope.product_types.length,
      customer_personas: r.scope.customer_personas.length,
      license_types: r.license_types.map((l) => ({ _id: l._id, name: l.name })),
    })),
    legal: {
      legislative: model.legal.legislative.map((l) => ({ id: l.id, title: l.title, kind: l.kind, status: l.status, citation: l.citation })),
      judiciary: model.legal.judiciary.map((j) => ({ id: j.id, title: j.title, court: j.court, decided_on: j.decided_on, status: j.status })),
    },
  };
}
