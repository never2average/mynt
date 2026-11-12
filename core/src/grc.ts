import { z } from "zod";

// GRC for a licence.
// - Data: obligations, filings and risks are things the regulator requires or has identified.
// - Templates ("schemas of schemas"): controls, policies, risk models and inspection records are
//   kinds of record a licensee must keep. Each template teaches how to define one: guidance, the law
//   behind it, and a field schema the licensee's own records must follow.

const Id = z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/, "Use a lowercase id like 'kyc_policy'");

// ---- shared vocabulary ------------------------------------------------------------------------

export const FREQUENCIES = [
  "one_time",
  "daily",
  "weekly",
  "fortnightly",
  "monthly",
  "bi_monthly",
  "quarterly",
  "half_yearly",
  "annual",
  "biennial",
  "periodic",
  "event_driven",
  "continuous",
  "on_demand",
] as const;
export type Frequency = (typeof FREQUENCIES)[number];

const FREQUENCY_ALIASES: Record<string, Frequency> = {
  once: "one_time",
  onetime: "one_time",
  biweekly: "fortnightly",
  bi_weekly: "fortnightly",
  bimonthly: "bi_monthly",
  semi_annual: "half_yearly",
  semiannual: "half_yearly",
  semi_annually: "half_yearly",
  bi_annually: "half_yearly",
  biannual: "half_yearly",
  yearly: "annual",
  annually: "annual",
  every_2_years: "biennial",
  ongoing: "continuous",
  on_event: "event_driven",
  per_event: "event_driven",
  event_based: "event_driven",
  event_triggered: "event_driven",
  pre_event: "event_driven",
  post_event: "event_driven",
  conditional: "event_driven",
  as_and_when: "event_driven",
  ad_hoc: "on_demand",
  adhoc: "on_demand",
  as_needed: "on_demand",
};

// Cadences that map to the vocabulary but carry detail worth keeping ("per claim", "every 3 years").
const DETAILED_PATTERNS: [RegExp, Frequency][] = [
  [/^per_/, "event_driven"],
  [/^every_\d+_(years?|months?|weeks?|days?)$/, "periodic"],
];

// value: the cadence it maps to; detailed: whether the original wording should be kept as a note.
export function classifyFrequency(raw: unknown): { value?: Frequency; detailed: boolean } {
  if (typeof raw !== "string") return { detailed: false };
  const key = raw.trim().toLowerCase().replace(/[\s/+-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  if ((FREQUENCIES as readonly string[]).includes(key)) return { value: key as Frequency, detailed: false };
  if (FREQUENCY_ALIASES[key]) return { value: FREQUENCY_ALIASES[key], detailed: false };
  const hit = DETAILED_PATTERNS.find(([re]) => re.test(key));
  return hit ? { value: hit[1], detailed: true } : { detailed: false };
}

export function normalizeFrequency(raw: unknown): Frequency | undefined {
  return classifyFrequency(raw).value;
}

const Frequency = z.preprocess((v) => normalizeFrequency(v) ?? v, z.enum(FREQUENCIES));

// A free-text `frequency` becomes the cadence when it maps, otherwise a note (never lost).
const liftFrequency = (into: string) => (v: unknown) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const o = { ...(v as Record<string, unknown>) };
  if (typeof o.frequency !== "string") return o;
  const { value: f, detailed } = classifyFrequency(o.frequency);
  if (!f || detailed) o.frequency_note ??= o.frequency;
  if (into === "frequency") {
    if (f) o.frequency = f;
    else delete o.frequency;
  } else {
    if (f && o[into] === undefined) o[into] = f;
    delete o.frequency;
  }
  return o;
};

export const LEVELS = ["low", "medium", "high"] as const;
export const CONTROL_TYPES = ["preventive", "detective", "corrective", "directive", "compensating", "recovery"] as const;
export const TEST_METHODS = ["manual", "automated", "it_dependent_manual"] as const;
export const TEST_STATUSES = ["not_started", "scheduled", "in_progress", "completed", "overdue"] as const;
export const TEST_RATINGS = ["effective", "partially_effective", "ineffective", "not_tested"] as const;
export const CONTROL_STATUSES = ["draft", "active", "under_review", "retired"] as const;
export const POLICY_STATUSES = ["draft", "approved", "in_review", "superseded"] as const;
export const INSPECTION_TYPES = ["onsite_inspection", "offsite_review", "thematic_review", "investigation", "audit"] as const;
export const INSPECTION_CHANNELS = ["written_request", "meeting", "regulator_portal", "email", "other"] as const;
export const INSPECTION_OUTCOMES = ["satisfactory", "needs_improvement", "unsatisfactory", "pending"] as const;
export const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "observation"] as const;
export const ACTION_STATUSES = ["open", "in_progress", "responded", "closed", "overdue"] as const;
export const SCORING_METHODS = ["likelihood_times_impact", "weighted_average", "matrix_lookup"] as const;
export const RESIDUAL_METHODS = ["inherent_less_control_effect", "inherent_times_control_factor", "matrix_lookup"] as const;
export const FACTOR_DIMENSIONS = ["impact", "likelihood", "control_effectiveness"] as const;

// ---- data registers ---------------------------------------------------------------------------

export const ObligationSchema = z.preprocess(
  liftFrequency("recurrence"),
  z.object({
    id: Id,
    title: z.string().min(1),
    description: z.string().default(""),
    how_to_comply: z.string().optional(),
    recurrence: Frequency.optional(),
    frequency_note: z.string().optional().describe("Cadence detail the vocabulary can't express"),
    effective_date: z.string().optional(),
    criticality: z.enum(LEVELS).default("medium"),
    category: z.string().optional(),
    tags: z.array(z.string()).default([]),
    risk_ref: z.string().optional().describe("Risk id in this licence's risks register"),
    owner: z.string().optional().describe("Mandatory stakeholder id accountable for it"),
    legal_ref: z.string().optional().describe("Id of the legislation or judgment it comes from"),
  }),
);

export const FilingSchema = z.preprocess(
  liftFrequency("frequency"),
  z.object({
    id: Id,
    name: z.string().min(1),
    category: z.enum(["reporting", "disclosure", "filing"]).default("filing"),
    description: z.string().default(""),
    frequency: Frequency.optional(),
    frequency_note: z.string().optional(),
    due: z.string().optional().describe("Due-date rule, e.g. 'within 30 days of quarter end'"),
    form: z.string().optional().describe("Return or form name/number"),
    channels: z.array(z.string()).default([]).describe("Submission portals or channels"),
    recipient: z.string().optional(),
    priority: z.enum(LEVELS).optional(),
    obligation_ref: z.string().optional().describe("Obligation id this filing evidences"),
    legal_ref: z.string().optional(),
  }),
);

export const RiskSchema = z.object({
  id: Id,
  title: z.string().min(1),
  description: z.string().default(""),
  category: z.string().optional(),
  impact: z.enum(LEVELS).optional(),
  likelihood: z.enum([...LEVELS, "unknown"]).optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  control_test_frequency: Frequency.optional().describe("How often controls over this risk must be tested"),
});

// ---- templates ("schemas of schemas") --------------------------------------------------------

export const FIELD_TYPES = [
  "string",
  "text",
  "number",
  "integer",
  "boolean",
  "date",
  "datetime",
  "enum",
  "multi_enum",
  "reference",
  "url",
  "file",
  "object",
  "array",
] as const;

export interface FieldDef {
  key: string;
  label: string;
  type: (typeof FIELD_TYPES)[number];
  required: boolean;
  description: string;
  guidance?: string;
  legal_ref?: string;
  enum_values?: string[];
  reference_to?: string;
  item_type?: (typeof FIELD_TYPES)[number];
  fields?: FieldDef[];
}

export const FieldDefSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]*$/, "Use a snake_case key"),
    label: z.string().min(1),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().default(false),
    description: z.string().default(""),
    guidance: z.string().optional().describe("What the regulator expects here, in plain words"),
    legal_ref: z.string().optional(),
    enum_values: z.array(z.string().min(1)).optional(),
    reference_to: z.string().optional().describe("What a reference points at: risk, obligation, stakeholder, legal, policy, control, regulator, file"),
    item_type: z.enum(FIELD_TYPES).optional().describe("For arrays of plain values"),
    get fields() {
      return z.array(FieldDefSchema).optional().describe("For object fields and arrays of objects");
    },
  })
  .superRefine((f, ctx) => {
    if ((f.type === "enum" || f.type === "multi_enum" || f.item_type === "enum") && !f.enum_values?.length)
      ctx.addIssue({ code: "custom", message: `field '${f.key}' is an enum but has no enum_values` });
    if (f.type === "object" && !f.fields?.length) ctx.addIssue({ code: "custom", message: `object field '${f.key}' needs fields` });
  }) as unknown as z.ZodType<FieldDef>;

export const TEMPLATE_KINDS = ["control", "policy", "risk_model", "inspection_record", "inspection_event"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

// Earlier data-shaped items (controls with a title, repository items with title/date/url/summary)
// read as templates.
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "item";
const liftLegacyTemplate = (v: unknown) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const o = { ...(v as Record<string, unknown>) };
  if (o.name === undefined && typeof o.title === "string") o.name = o.title;
  if (o.id === undefined && typeof o.name === "string") o.id = slug(o.name);
  if (o.description === undefined && typeof o.summary === "string") o.description = o.summary;
  if (o.source_url === undefined && typeof o.url === "string") o.source_url = o.url;
  if (o.issued_on === undefined && typeof o.date === "string") o.issued_on = o.date;
  delete o.title;
  delete o.summary;
  delete o.url;
  delete o.date;
  return o;
};

const templateBase = {
  id: Id,
  name: z.string().min(1),
  description: z.string().default(""),
  guidance: z.string().default("").describe("How the regulator expects licensees to define and run this"),
  legal_ref: z.string().optional().describe("Legislation or judgment id that mandates it"),
  mandatory: z.boolean().default(true),
  source_url: z.string().url().optional(),
  issued_on: z.string().optional(),
  extends_default: z.boolean().default(true).describe("Start from Mynt's default field schema for this kind"),
  fields: z.array(FieldDefSchema).default([]).describe("Fields added to (or overriding, by key) the default schema"),
};

export const ControlTemplateSchema = z.preprocess(
  liftLegacyTemplate,
  z.object({
    ...templateBase,
    mitigates: z.array(z.string()).default([]).describe("Risk ids in this licence's risks register"),
    owner: z.string().optional().describe("Mandatory stakeholder id who owns the control"),
    minimum_test_frequency: Frequency.optional(),
  }),
);
export const PolicyTemplateSchema = z.preprocess(
  liftLegacyTemplate,
  z.object({
    ...templateBase,
    review_frequency: Frequency.optional(),
    approved_by: z.string().optional().describe("Stakeholder id that must approve it, e.g. the board"),
  }),
);
export const RiskModelTemplateSchema = z.preprocess(
  liftLegacyTemplate,
  z.object({ ...templateBase, validation_frequency: Frequency.optional() }),
);
export const InspectionRecordTemplateSchema = z.preprocess(
  liftLegacyTemplate,
  z.object({ ...templateBase, inspection_type: z.enum(INSPECTION_TYPES).optional() }),
);
export const InspectionEventTemplateSchema = z.preprocess(
  liftLegacyTemplate,
  z.object({ ...templateBase, inspection_type: z.enum(INSPECTION_TYPES).optional() }),
);

// ---- default field schemas ---------------------------------------------------------------------

const f = (key: string, label: string, type: FieldDef["type"], extra: Partial<FieldDef> = {}): FieldDef => ({
  key,
  label,
  type,
  required: false,
  description: "",
  ...extra,
});
const req = { required: true };

export const DEFAULT_FIELDS: Record<TemplateKind, FieldDef[]> = {
  control: [
    f("title", "Control", "string", req),
    f("objective", "Control objective", "text", req),
    f("control_type", "Control type", "enum", { ...req, enum_values: [...CONTROL_TYPES] }),
    f("test_method", "Test method", "enum", { ...req, enum_values: [...TEST_METHODS] }),
    f("evidence_method", "Evidence gathered", "enum", { enum_values: [...TEST_METHODS] }),
    f("test_frequency", "Test frequency", "enum", { ...req, enum_values: [...FREQUENCIES] }),
    f("test_procedure", "Test procedure", "array", { item_type: "text" }),
    f("test_status", "Test status", "enum", { enum_values: [...TEST_STATUSES] }),
    f("last_tested_on", "Last tested on", "date"),
    f("last_test_rating", "Last test rating", "enum", { enum_values: [...TEST_RATINGS] }),
    f("status", "Status", "enum", { ...req, enum_values: [...CONTROL_STATUSES] }),
    f("risks", "Risks addressed", "array", { item_type: "reference", reference_to: "risk" }),
    f("owner", "Owner", "reference", { ...req, reference_to: "stakeholder" }),
    f("reviewer", "Reviewer", "reference", { reference_to: "stakeholder" }),
    f("evidence", "Evidence", "array", { item_type: "file" }),
    f("source_clause", "Source clause", "string"),
  ],
  policy: [
    f("title", "Policy", "string", req),
    f("version", "Version", "string", req),
    f("status", "Status", "enum", { ...req, enum_values: [...POLICY_STATUSES] }),
    f("purpose", "Purpose and scope", "text", req),
    f("effective_date", "Effective date", "date", req),
    f("review_frequency", "Review frequency", "enum", { ...req, enum_values: [...FREQUENCIES] }),
    f("next_review_date", "Next review date", "date"),
    f("owner", "Owner", "reference", { ...req, reference_to: "stakeholder" }),
    f("approved_by", "Approved by", "reference", { ...req, reference_to: "stakeholder" }),
    f("approved_on", "Approved on", "date"),
    f("sections", "Sections", "array", {
      ...req,
      fields: [f("heading", "Heading", "string", req), f("content", "Content", "text", req), f("legal_ref", "Legal basis", "reference", { reference_to: "legal" })],
    }),
    f("controls", "Controls implementing it", "array", { item_type: "reference", reference_to: "control" }),
    f("document", "Approved document", "file"),
  ],
  risk_model: [
    f("name", "Model", "string", req),
    f("purpose", "Purpose", "text", req),
    f("inherent_scoring", "Inherent scoring method", "enum", { ...req, enum_values: [...SCORING_METHODS] }),
    f("residual_scoring", "Residual scoring method", "enum", { ...req, enum_values: [...RESIDUAL_METHODS] }),
    f("rating_scale", "Rating scale", "array", {
      ...req,
      fields: [f("label", "Label", "string", req), f("score", "Score", "number", req), f("from", "Range from", "number"), f("to", "Range to", "number")],
    }),
    f("factors", "Factors", "array", {
      ...req,
      fields: [
        f("name", "Factor", "string", req),
        f("dimension", "Dimension", "enum", { ...req, enum_values: [...FACTOR_DIMENSIONS] }),
        f("weight", "Weight", "number"),
        f("description", "What it measures", "text"),
      ],
    }),
    f("thresholds", "Residual thresholds", "array", {
      fields: [
        f("label", "Label", "string", req),
        f("from", "Score from", "number", req),
        f("to", "Score to", "number", req),
        f("test_frequency", "Control test frequency", "enum", { enum_values: [...FREQUENCIES] }),
      ],
    }),
    f("validation_frequency", "Validation frequency", "enum", { enum_values: [...FREQUENCIES] }),
    f("owner", "Owner", "reference", { ...req, reference_to: "stakeholder" }),
    f("last_validated_on", "Last validated on", "date"),
  ],
  inspection_record: [
    f("title", "Inspection", "string", req),
    f("inspection_type", "Type", "enum", { ...req, enum_values: [...INSPECTION_TYPES] }),
    f("conducted_by", "Conducted by", "reference", { ...req, reference_to: "regulator" }),
    f("lead_inspector", "Lead inspector", "string"),
    f("scope", "Scope", "text", req),
    f("period_from", "Period from", "date"),
    f("period_to", "Period to", "date"),
    f("outcome", "Outcome", "enum", { enum_values: [...INSPECTION_OUTCOMES] }),
    f("findings", "Findings", "array", {
      fields: [
        f("title", "Finding", "string", req),
        f("severity", "Severity", "enum", { ...req, enum_values: [...FINDING_SEVERITIES] }),
        f("action_status", "Action status", "enum", { enum_values: [...ACTION_STATUSES] }),
        f("action_due", "Action due", "date"),
      ],
    }),
    f("report", "Report", "file"),
  ],
  inspection_event: [
    f("title", "Event", "string", req),
    f("inspection_type", "Type", "enum", { ...req, enum_values: [...INSPECTION_TYPES] }),
    f("channel", "Received via", "enum", { ...req, enum_values: [...INSPECTION_CHANNELS] }),
    f("occurred_at", "Occurred at", "datetime", req),
    f("details", "Details", "text"),
    f("inspection", "Inspection", "reference", { reference_to: "inspection_record" }),
    f("requested_items", "Information requested", "array", { item_type: "text" }),
    f("response_due", "Response due", "date"),
    f("status", "Status", "enum", { ...req, enum_values: [...ACTION_STATUSES] }),
    f("owner", "Responsible", "reference", { reference_to: "stakeholder" }),
  ],
};

// The schema a licensee's records of this template must follow.
export function resolveFields(kind: TemplateKind, t: { extends_default?: boolean; fields?: FieldDef[] }): FieldDef[] {
  const own = t.fields ?? [];
  if (t.extends_default === false) return own;
  const byKey = new Map(DEFAULT_FIELDS[kind].map((d) => [d.key, d]));
  for (const x of own) byKey.set(x.key, x);
  return [...byKey.values()];
}

export function fieldKeyDupes(fields: FieldDef[], at = ""): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of fields) {
    if (seen.has(x.key)) out.push(`${at}${x.key}`);
    seen.add(x.key);
    if (x.fields) out.push(...fieldKeyDupes(x.fields, `${at}${x.key}.`));
  }
  return out;
}
