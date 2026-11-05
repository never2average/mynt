import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ClerkAdmin } from "./auth.js";
import type { BuildService } from "./builds.js";
import type { BdService } from "./bd.js";
import type { DeskService } from "./desk.js";
import type { ExploreService } from "./explore.js";
import type { ReviewService } from "./review.js";
import { PRODUCT_LINES } from "./catalog.js";
import { runProductTests } from "./product-tests.js";
import {
  JudgmentSchema,
  LegacyLegalSchema,
  legacyToJudgment,
  legalIds,
  hydrateRegulators,
  LegislativeSchema,
  normalizeModel,
  RegulatedProductTypeSchema,
  RegulatorSchema,
  splitRegulator,
  validateProductType,
  validateRegulator,
  type Judgment,
  type Legislation,
  type RegulatoryModel,
} from "./regulatory.js";
import { ROLES, type Role, type Store, type User } from "./store.js";
import type { VendorCallOptions } from "./vendor-call.js";
import { emitProductEvent } from "./runtime.js";
import type { HostingService } from "./hosting.js";
import type { ModuleRegistry } from "./modules.js";
import { driftSweep } from "./pins.js";
import { recomputeDerived, rederiveProduct } from "./derived.js";
import { vendorDriftSweep } from "./vendors.js";
import { reconcileEntityGrc } from "./entity-grc.js";
import { reconcileEntity } from "./parties.js";
import { ComponentSchema, PartyBindingSchema, productRegime, validateComposition } from "./regime.js";
import { ENTITY_STATUSES } from "./store.js";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

export interface AdminContext {
  clerkAdmin?: ClerkAdmin | null; // keeps Clerk's allowlist in step with the whitelist
  builds?: BuildService | null; // coding-agent builds, when enabled
  bd?: BdService | null; // the business-development connector agent
  desk?: DeskService | null; // innovators' product desk: workspaces, term sheets, feasibility
  review?: ReviewService | null; // the governance desk: agent-researched review cases admins decide
  explore?: ExploreService | null; // the desk's algorithm explorations
  bdRun?: { id: string } | null; // set when the caller is a connector agent run, not a person
  hosting?: HostingService | null; // developers' isolated app hosting, when configured
  modules?: ModuleRegistry | null; // developers' published modules
  vendors?: VendorCallOptions; // how Mynt calls vendors' services (tests only override the defaults)
}

// Admin: everything is managed through Mynt itself, and every change is written to the audit log.
export function registerAdminTools(server: McpServer, store: Store, user: User, ctx: AdminContext = {}) {
  const audit = (action: string, target: string, details: unknown = {}) => store.audit(user.id, action, target, details);

  // ---- reference data ----

  server.registerTool(
    "define_region",
    {
      title: "Define a region",
      description:
        "Admin: add or change a geography products may be offered in: its regulators, regulatory ecosystem, the legal procedure to launch each product line there, and the official sources. Fields you leave out keep their current value. Set active=false to stop new products using it (live products stay).",
      inputSchema: {
        code: z.string().regex(/^(global|[A-Z]{2})$/, "Use 'global' or an ISO country code like IN, US, GB"),
        name: z.string().min(1).optional(),
        regulators: z
          .array(z.string().min(1))
          .optional()
          .describe("Short names of the regulators products here answer to, e.g. RBI, SEBI, IRDAI. test_product checks a product's regulator against these."),
        ecosystem: z
          .string()
          .optional()
          .describe("Markdown overview: each regulator's remit, the key laws and regulations, self-regulatory bodies, and how they interact"),
        procedures: z
          .array(
            z.object({
              product_line: z.enum(PRODUCT_LINES),
              name: z.string().min(1).describe("e.g. 'Mutual fund scheme launch'"),
              regulator: z.string().min(1),
              steps: z.array(z.string().min(1)).min(1).describe("Licences, registrations, approvals and filings, in order"),
              typical_timeline: z.string().optional(),
              notes: z.string().optional().describe("Thresholds, exemptions, ongoing obligations, caveats"),
            }),
          )
          .optional()
          .describe("How each product line (credit, securitization, payments, account_operations, custody_settlement, wealth, insurance, guarantees_trade, exchange, derivatives, information) is legally brought to market here. Replaces the region's whole list when given."),
        sources: z.array(z.string().url()).optional().describe("Official regulator or statute pages the content is drawn from"),
        active: z.boolean().optional(),
      },
    },
    async (region) => {
      const saved = await store.upsertRegion(region);
      await audit("define_region", region.code, region);
      return json(saved);
    },
  );

  server.registerTool(
    "define_product_category",
    {
      title: "Define a product category",
      description:
        "Admin: add or change a product type and the product lines it can be used in. Lines are by economic function, not asset class: credit, securitization, payments, account_operations, custody_settlement, wealth, insurance, guarantees_trade, exchange, derivatives, information. A category can sit in several (e.g. exchange_traded: wealth and securitization). Set active=false to retire it for new products.",
      inputSchema: {
        id: z.string().regex(/^[a-z][a-z0-9_]*$/, "Use a snake_case id like mutual_funds"),
        name: z.string().min(1),
        product_lines: z.array(z.enum(PRODUCT_LINES)).min(1),
        description: z.string().default(""),
        active: z.boolean().default(true),
      },
    },
    async (category) => {
      const saved = await store.upsertCategory(category);
      await audit("define_product_category", category.id, category);
      return json(saved);
    },
  );

  // ---- regulatory model: regulators (scope, licences, GRC) and legal instruments ----

  const regionFor = async (code: string) => (await store.referenceData(true)).regions.find((r) => r.code === code);

  server.registerTool(
    "define_regulated_product_type",
    {
      title: "Define a regulated product type",
      description:
        "Admin: add or replace a product type in a region's regulated product catalogue (e.g. term deposit, listed NCD, ULIP): its Mynt category, every action that can be taken on it (issuance, sale, purchase, secondary_sale, repackaging, advice, servicing, underwriting, assessment; assessment is an independent rating, valuation, index, actuarial certification, audit or accreditation), and optionally its underlying (what it is made of) and wrapper (a statutory pension, tax-advantaged or government-scheme structure around it). Product types live apart from regulators; each regulator then maps the ones it supervises (define_regulator scope.product_types), so one product type can sit under several regulators. Narrowing actions is refused while a regulator still supervises the dropped ones.",
      inputSchema: { region: z.string().describe("Region code, e.g. IN"), product_type: RegulatedProductTypeSchema },
    },
    async ({ region: code, product_type }) => {
      const region = await regionFor(code);
      if (!region) return fail(`No region '${code}'; create it with define_region first`);
      const ref = await store.referenceData(true);
      const errors = validateProductType(product_type, { categories: ref.categories.filter((c) => c.active).map((c) => c.id) });
      for (const m of await store.productMappings(code)) {
        if (m.product_type_id !== product_type.id) continue;
        const dropped = m.actions.filter((a) => !product_type.actions.includes(a));
        if (dropped.length) errors.push(`${m.regulator_id} still supervises '${dropped.join(", ")}' on '${product_type.id}'; update that regulator first`);
      }
      if (errors.length) return { ...json({ error: "The product type can't be saved", errors }), isError: true };
      const { replaced } = await store.upsertRegulatedProductType(code, product_type);
      await audit("define_regulated_product_type", `${code}/${product_type.id}`, {
        replaced,
        type_id: product_type.type_id,
        actions: product_type.actions,
        underlying: product_type.underlying ?? null,
        wrapper: product_type.wrapper ?? null,
      });
      await recomputeDerived(store, { region: code });
      return json({ region: code, product_type: product_type.id, replaced });
    },
  );

  server.registerTool(
    "remove_regulated_product_type",
    {
      title: "Remove a regulated product type",
      description: "Admin: delete a product type from a region's catalogue. Refused while any regulator still supervises it.",
      inputSchema: { region: z.string(), product_type_id: z.string() },
    },
    async ({ region: code, product_type_id }) => {
      const users = (await store.productMappings(code)).filter((m) => m.product_type_id === product_type_id).map((m) => m.regulator_id);
      if (users.length) return fail(`'${product_type_id}' is supervised by ${users.join(", ")}; remove it from their scope first`);
      if (!(await store.removeRegulatedProductType(code, product_type_id))) return fail(`No regulated product type '${product_type_id}' in ${code}`);
      await audit("remove_regulated_product_type", `${code}/${product_type_id}`);
      await recomputeDerived(store, { region: code });
      return json({ region: code, removed: product_type_id });
    },
  );

  server.registerTool(
    "define_regulator",
    {
      title: "Define a regulator",
      description:
        "Admin: add or replace one regulator in a region's regulatory model: the regulated product types it supervises (ids from the region's catalogue, see define_regulated_product_type, each with the actions it supervises), customer personas and their qualifications, and the licences it grants, each with its GRC (obligations, filings, risks, controls, repositories, the product types and actions it grants, allowed segments, mandatory internal and external stakeholders). Persona and licence ids must start with '<regulator id>_' and can't be used by another regulator in the region. Broken links are refused; links to law not yet recorded come back as warnings.",
      inputSchema: { region: z.string().describe("Region code, e.g. IN (define_region first)"), regulator: RegulatorSchema },
    },
    async ({ region: code, regulator }) => {
      const region = await regionFor(code);
      if (!region) return fail(`No region '${code}'; create it with define_region first`);
      const model = normalizeModel(region.regulatory);
      const catalogue = await store.regulatedProductTypes(code);
      const { errors, warnings } = validateRegulator(regulator, {
        legalIds: legalIds(model),
        productTypes: catalogue,
        otherRegulators: model.regulators,
      });
      if (errors.length) return { ...json({ error: "The regulator has broken links", errors, warnings }), isError: true };
      const replaced = model.regulators.some((r) => r.id === regulator.id);
      const { stored, mappings } = splitRegulator(regulator, catalogue);
      const [hydrated] = hydrateRegulators([stored], catalogue, mappings);
      await store.setRegulatoryModel(code, { ...model, regulators: [...model.regulators.filter((r) => r.id !== regulator.id), hydrated] });
      // Keep the region's short regulator list (used to check what products cite) in step.
      const short = regulator.short_name ?? regulator.name;
      if (!region.regulators.includes(short)) await store.upsertRegion({ code, regulators: [...region.regulators, short] });
      await audit("define_regulator", `${code}/${regulator.id}`, { replaced, license_types: regulator.license_types.map((l) => l._id) });
      // Coverage, stakeholders and workload follow the model: recompute what's stored on the region's products.
      await recomputeDerived(store, { region: code });
      return json({ region: code, regulator: regulator.id, replaced, license_types: regulator.license_types.length, warnings });
    },
  );

  server.registerTool(
    "remove_regulator",
    {
      title: "Remove a regulator",
      description: "Admin: delete one regulator (and its licences) from a region's regulatory model.",
      inputSchema: { region: z.string(), regulator_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ region: code, regulator_id }) => {
      const region = await regionFor(code);
      if (!region) return fail(`No region '${code}'`);
      const model = normalizeModel(region.regulatory);
      const gone = model.regulators.find((r) => r.id === regulator_id);
      if (!gone) return fail(`No regulator '${regulator_id}' in ${code}`);
      await store.setRegulatoryModel(code, { ...model, regulators: model.regulators.filter((r) => r.id !== regulator_id) });
      await audit("remove_regulator", `${code}/${regulator_id}`);
      await recomputeDerived(store, { region: code });
      return json({ region: code, removed: regulator_id });
    },
  );

  // Legal: the legislative branch (acts, rules, directions, circulars...) and the judiciary (case law).
  const saveLegal = async (code: string, legal: RegulatoryModel["legal"]) => {
    const region = (await regionFor(code))!;
    await store.setRegulatoryModel(code, { ...normalizeModel(region.regulatory), legal });
  };

  const legislationWarnings = (code: string, model: RegulatoryModel, l: Legislation) => {
    const regulatorIds = model.regulators.map((r) => r.id);
    return [
      ...(l.issued_by && l.issued_by !== "parliament" && !regulatorIds.includes(l.issued_by) ? [`issued_by '${l.issued_by}' isn't a regulator in ${code}`] : []),
      ...(l.parent_id && !model.legal.legislative.some((x) => x.id === l.parent_id) ? [`parent_id '${l.parent_id}' isn't recorded legislation in ${code}`] : []),
      ...l.applies_to.regulators.filter((id) => !regulatorIds.includes(id)).map((id) => `applies to unknown regulator '${id}'`),
    ];
  };

  const putLegislation = async (code: string, l: Legislation) => {
    const model = normalizeModel((await regionFor(code))!.regulatory);
    const warnings = legislationWarnings(code, model, l);
    const replaced = model.legal.legislative.some((x) => x.id === l.id);
    await saveLegal(code, { ...model.legal, legislative: [...model.legal.legislative.filter((x) => x.id !== l.id), l] });
    await audit("define_legislation", `${code}/${l.id}`, { kind: l.kind, replaced });
    return { region: code, branch: "legislative", id: l.id, replaced, warnings };
  };

  const putJudgment = async (code: string, j: Judgment) => {
    const model = normalizeModel((await regionFor(code))!.regulatory);
    const legislativeIds = model.legal.legislative.map((x) => x.id);
    const regulatorIds = model.regulators.map((r) => r.id);
    const warnings = [
      ...j.interprets.filter((id) => !legislativeIds.includes(id)).map((id) => `interprets '${id}', which isn't recorded legislation in ${code}`),
      ...j.applies_to.regulators.filter((id) => !regulatorIds.includes(id)).map((id) => `applies to unknown regulator '${id}'`),
    ];
    const replaced = model.legal.judiciary.some((x) => x.id === j.id);
    await saveLegal(code, { ...model.legal, judiciary: [...model.legal.judiciary.filter((x) => x.id !== j.id), j] });
    await audit("define_judgment", `${code}/${j.id}`, { court_level: j.court_level, replaced });
    return { region: code, branch: "judiciary", id: j.id, replaced, warnings };
  };

  server.registerTool(
    "define_legislation",
    {
      title: "Define legislation",
      description:
        "Admin: add or replace a legislative instrument in a region (act, ordinance, rule, regulation, master direction, circular, guideline, notification, order) with its citation, issuer, the instrument it is made under, effective date, status, official URL, summary and what it applies to. Obligations and filings cite it by id (legal_ref).",
      inputSchema: { region: z.string(), instrument: LegislativeSchema },
    },
    async ({ region: code, instrument }) => {
      if (!(await regionFor(code))) return fail(`No region '${code}'; create it with define_region first`);
      return json(await putLegislation(code, instrument));
    },
  );

  server.registerTool(
    "define_judgment",
    {
      title: "Define a judgment",
      description:
        "Admin: add or replace a court or tribunal decision in a region: case name, court and level, citation, date, bench, holding, the legislation it interprets, whether it is still good law, official URL and what it applies to. Obligations and filings can cite it by id (legal_ref).",
      inputSchema: { region: z.string(), judgment: JudgmentSchema },
    },
    async ({ region: code, judgment }) => {
      if (!(await regionFor(code))) return fail(`No region '${code}'; create it with define_region first`);
      return json(await putJudgment(code, judgment));
    },
  );

  for (const [name, branch, title] of [
    ["remove_legislation", "legislative", "Remove legislation"],
    ["remove_judgment", "judiciary", "Remove a judgment"],
  ] as const) {
    server.registerTool(
      name,
      {
        title,
        description: `Admin: delete one ${branch === "legislative" ? "legislative instrument" : "judgment"} from a region.`,
        inputSchema: { region: z.string(), id: z.string() },
        annotations: { destructiveHint: true },
      },
      async ({ region: code, id }) => {
        const region = await regionFor(code);
        if (!region) return fail(`No region '${code}'`);
        const model = normalizeModel(region.regulatory);
        const list = model.legal[branch] as { id: string }[];
        if (!list.some((x) => x.id === id)) return fail(`No ${branch} item '${id}' in ${code}`);
        await saveLegal(code, { ...model.legal, [branch]: list.filter((x) => x.id !== id) });
        await audit(name, `${code}/${id}`);
        return json({ region: code, branch, removed: id });
      },
    );
  }

  // Deprecated: the earlier single list. Routes judgments to the judiciary and everything else to
  // legislation, so sessions started before the split keep working.
  server.registerTool(
    "define_legal_instrument",
    {
      title: "Define a legal instrument (deprecated)",
      description: "Deprecated: use define_legislation or define_judgment. Files kind 'judgment' under the judiciary and everything else under legislation.",
      inputSchema: { region: z.string(), instrument: LegacyLegalSchema },
    },
    async ({ region: code, instrument }) => {
      if (!(await regionFor(code))) return fail(`No region '${code}'; create it with define_region first`);
      const result =
        instrument.kind === "judgment"
          ? await putJudgment(code, legacyToJudgment(instrument))
          : await putLegislation(code, LegislativeSchema.parse(instrument));
      return json({ ...result, deprecated: "use define_legislation or define_judgment" });
    },
  );

  server.registerTool(
    "remove_legal_instrument",
    {
      title: "Remove a legal instrument (deprecated)",
      description: "Deprecated: use remove_legislation or remove_judgment. Removes the id from whichever branch holds it.",
      inputSchema: { region: z.string(), instrument_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ region: code, instrument_id }) => {
      const region = await regionFor(code);
      if (!region) return fail(`No region '${code}'`);
      const model = normalizeModel(region.regulatory);
      const legislative = model.legal.legislative.filter((x) => x.id !== instrument_id);
      const judiciary = model.legal.judiciary.filter((x) => x.id !== instrument_id);
      if (legislative.length + judiciary.length === model.legal.legislative.length + model.legal.judiciary.length)
        return fail(`No legal item '${instrument_id}' in ${code}`);
      await saveLegal(code, { legislative, judiciary });
      await audit("remove_legal_instrument", `${code}/${instrument_id}`);
      return json({ region: code, removed: instrument_id });
    },
  );

  // ---- firms and their licences ----

  server.registerTool(
    "list_entities",
    {
      title: "Firms",
      description: "Admin: every registered legal entity with its members, licences, party roster, and each licence's mandated stakeholders reconciled against the roster.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const ref = await store.referenceData(true);
      return json(
        await Promise.all(
          (await store.listEntities()).map(async (e) => ({
            ...e,
            members: (await store.entityMembers(e.id)).map((m) => ({ id: m.id, name: m.name, email: m.email })),
            licenses: await store.licensesOf(e.id),
            parties: await store.partiesOf(e.id),
            reconciliation: await reconcileEntity(store, e.id, ref),
            grc: await reconcileEntityGrc(store, e.id, ref),
          })),
        ),
      );
    },
  );

  server.registerTool(
    "set_entity_status",
    {
      title: "Set a legal entity's status",
      description:
        "Admin: record a legal entity's status from its company registry (active, suspended, under_liquidation, dissolved, struck_off). Every published product resting on it is re-checked, and drifted ones pause new sales.",
      inputSchema: { entity_id: z.string(), status: z.enum(ENTITY_STATUSES), note: z.string().optional() },
    },
    async ({ entity_id, status, note }) => {
      if (!(await store.getEntity(entity_id))) return fail(`No legal entity '${entity_id}'`);
      const entity = await store.setEntityStatus(entity_id, status);
      await audit("set_entity_status", entity_id, { status, note });
      return json({ ...entity, drifted_products: await driftSweep(store, entity_id) });
    },
  );

  server.registerTool(
    "add_entity_member",
    {
      title: "Add someone to a firm",
      description: "Admin: make a signed-in user a member of a firm (they then act for it as an innovator or a vendor, by their roles).",
      inputSchema: { email: z.string().email(), entity_id: z.string() },
    },
    async ({ email, entity_id }) => {
      const member = await store.userByEmail(email);
      if (!member) return fail(`${email} hasn't signed in to Mynt yet`);
      const entity = await store.getEntity(entity_id);
      if (!entity) return fail(`No firm '${entity_id}'`);
      await store.setUserEntity(member.id, entity.id);
      await audit("add_entity_member", entity.id, { email: member.email });
      return json({ entity_id: entity.id, entity: entity.name, member: member.email });
    },
  );

  server.registerTool(
    "list_license_reviews",
    {
      title: "Licences to review",
      description: "Admin: licences firms have registered, by review status (pending by default).",
      inputSchema: { status: z.enum(["pending", "verified", "rejected", "suspended"]).default("pending") },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) =>
      json(
        await Promise.all(
          (await store.licensesByStatus(status)).map(async (l) => ({ ...l, entity: (await store.getEntity(l.entity_id))?.name })),
        ),
      ),
  );

  server.registerTool(
    "review_license",
    {
      title: "Verify a firm's licence",
      description:
        "Admin: verify, reject or suspend a licence a firm registered, after checking it against the regulator's public register. Only verified, in-date licences let a firm publish products.",
      inputSchema: { license_record_id: z.string(), decision: z.enum(["verified", "rejected", "suspended"]), note: z.string().optional() },
    },
    async ({ license_record_id, decision, note }) => {
      const held = await store.getHeldLicense(license_record_id);
      if (!held) return fail(`No registered licence '${license_record_id}'`);
      const reviewed = await store.reviewLicense(held.id, decision, user.id, note ?? null);
      await audit("review_license", held.id, { decision, entity_id: held.entity_id, license: held.license_id });
      // A vendor's licence can carry its subscribers' products too.
      const drifted = [...(await driftSweep(store, held.entity_id)), ...(await vendorDriftSweep(store, { vendor_entity_id: held.entity_id }))];
      return json({ ...reviewed, drifted_products: [...new Set(drifted)] });
    },
  );

  // ---- whitelist and users ----

  const adminInvites = async () => (await store.listInvites()).filter((i) => i.roles.includes("admin")).map((i) => i.email);

  server.registerTool(
    "list_whitelist",
    {
      title: "Whitelist",
      description: "Admin: who may sign in to Mynt and with which roles, plus the users who have signed in, and whether public sign-up is on.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json({ public_signup: await store.publicSignup(), whitelist: await store.listInvites(), users: await store.listUsers() }),
  );

  server.registerTool(
    "set_public_signup",
    {
      title: "Open or close public sign-up",
      description:
        "Admin: when on, anyone who signs in with a verified email joins as a consumer (an invite is written for them, so they show in list_whitelist and can be revoked). Higher roles still need invite_user. People an admin revoked stay out. Also turns the sign-in provider's allowlist off (on when closing), best effort.",
      inputSchema: { enabled: z.boolean() },
    },
    async ({ enabled }) => {
      await store.setSetting("public_signup", { enabled }, user.id);
      const warning = ctx.clerkAdmin ? await ctx.clerkAdmin.setAllowlist(!enabled) : "no Clerk admin key configured: the sign-in provider's allowlist wasn't changed";
      await audit("set_public_signup", "public_signup", { enabled });
      return json({ public_signup: enabled, ...(warning ? { warning } : {}) });
    },
  );

  server.registerTool(
    "invite_user",
    {
      title: "Whitelist someone",
      description:
        "Admin: allow an email to sign in with the given roles, or change the roles of someone already whitelisted. Roles nest: admin > innovator > developer > consumer; vendor (firms offering standard services) is a peer of innovator with vendor tools only.",
      inputSchema: {
        email: z.string().email(),
        roles: z.array(z.enum(ROLES)).min(1),
      },
    },
    async ({ email, roles }) => {
      const lower = email.toLowerCase();
      const admins = await adminInvites();
      if (admins.includes(lower) && !roles.includes("admin") && admins.length === 1)
        return fail("That would remove the last admin; make someone else an admin first");
      const invite = await store.upsertInvite(lower, [...new Set(roles)] as Role[]);
      await store.unblockSignup(lower);
      const warnings = [(await ctx.clerkAdmin?.allow(lower)) ?? null, await mirrorToClerk(lower, invite.roles)].filter(Boolean);
      await audit("invite_user", lower, { roles: invite.roles });
      return json({ ...invite, ...(warnings.length ? { warnings } : {}) });
    },
  );

  // Keep roles granted in Clerk (public metadata) in step with Mynt for people who have signed in.
  const mirrorToClerk = async (email: string, roles: Role[] | null): Promise<string | null> => {
    const clerkUserId = ctx.clerkAdmin ? await store.clerkIdForEmail(email) : null;
    if (!clerkUserId) return null;
    try {
      await ctx.clerkAdmin!.setRoles(clerkUserId, roles);
      return null;
    } catch (e) {
      return `roles not updated in Clerk (${(e as Error).message})`;
    }
  };

  server.registerTool(
    "revoke_user",
    {
      title: "Remove someone from the whitelist",
      description: "Admin: stop an email from using Mynt. Takes effect on their next request; what they created stays.",
      inputSchema: { email: z.string().email() },
      annotations: { destructiveHint: true },
    },
    async ({ email }) => {
      const lower = email.toLowerCase();
      const admins = await adminInvites();
      if (admins.length === 1 && admins[0] === lower) return fail("That is the last admin; make someone else an admin first");
      if (!(await store.deleteInvite(lower))) return fail(`${lower} is not on the whitelist`);
      // Public sign-up mustn't let them straight back in as a consumer.
      await store.blockSignup(lower, user.id);
      await ctx.clerkAdmin?.disallow(lower);
      // Clear roles granted in Clerk too, or they would re-grant access on the next sign-in.
      const warning = await mirrorToClerk(lower, null);
      await audit("revoke_user", lower);
      return json({ revoked: lower, ...(warning ? { warning } : {}) });
    },
  );

  // ---- oversight ----

  server.registerTool(
    "list_all_campaigns",
    {
      title: "All campaigns",
      description: "Admin: every developer's campaigns, newest first.",
      inputSchema: { status: z.enum(["draft", "live", "paused", "ended"]).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => json((await store.allCampaigns()).filter((c) => !status || c.status === status)),
  );

  server.registerTool(
    "admin_pause_campaign",
    {
      title: "Pause any campaign",
      description: "Admin: take any live campaign down now (e.g. a compliance issue). Its developer can fix and relaunch it.",
      inputSchema: { campaign_id: z.string(), reason: z.string().min(3) },
    },
    async ({ campaign_id, reason }) => {
      const c = await store.getCampaign(campaign_id);
      if (!c) return fail(`No campaign with id '${campaign_id}'`);
      if (c.status !== "live") return fail(`Campaign is ${c.status}, not live`);
      const saved = await store.saveCampaign({ ...c, status: "paused" });
      await audit("admin_pause_campaign", campaign_id, { reason, owner_id: c.owner_id });
      return json(saved);
    },
  );

  server.registerTool(
    "admin_set_product_composition",
    {
      title: "Set a reference product's composition",
      description: "Admin: the regulated primitives one of Mynt's reference products (or any product) is made of, per jurisdiction. Reference products name no providers; a firm's product names them from its roster. Its regulatory regime follows (get_product_regime).",
      inputSchema: { product_id: z.string(), components: z.array(ComponentSchema).min(1).max(20), parties: z.array(PartyBindingSchema).max(100).default([]) },
    },
    async ({ product_id, components, parties }) => {
      const record = await store.getProduct(product_id);
      if (!record) return fail(`No product '${product_id}'`);
      const errors = await validateComposition(store, record, components, parties);
      if (errors.length) return { ...json({ error: "The composition can't be saved", errors }), isError: true };
      await store.setComposition(product_id, components, parties);
      await audit("admin_set_product_composition", product_id, { components: components.length });
      await rederiveProduct(store, product_id);
      return json(await productRegime(store, { ...record, components, parties }));
    },
  );

  server.registerTool(
    "recompute_product_derived",
    {
      title: "Recompute products' stored coverage and take rate",
      description:
        "Admin: recompute what Mynt stores on products from its own checks: each component's licence coverage (regulator and licence type), mandated stakeholders required and bound, publish blockers, and the effective take rate with its workload breakdown. One product, or every product when product_id is left out. It's also recomputed on publish, on composition and definition changes, on licence, roster and regulatory-model changes, hourly, and on boot.",
      inputSchema: { product_id: z.string().optional() },
    },
    async ({ product_id }) => {
      if (product_id && !(await store.getProduct(product_id))) return fail(`No product '${product_id}'`);
      const result = await recomputeDerived(store, product_id ? { product_ids: [product_id] } : {});
      await audit("recompute_product_derived", product_id ?? "*", result);
      return json(product_id ? { ...result, ...(await store.productDerived(product_id)) } : result);
    },
  );

  server.registerTool(
    "admin_set_product_status",
    {
      title: "Unpublish or republish any product",
      description:
        "Admin: unpublish any product (bundled ones included) now, or republish one; republishing runs the product tests against the current reference data and refuses if they fail.",
      inputSchema: { id: z.string(), status: z.enum(["published", "unpublished"]), reason: z.string().min(3) },
    },
    async ({ id, status, reason }) => {
      const record = await store.getProduct(id);
      if (!record) return fail(`No product with id '${id}'`);
      if (record.status === status) return fail(`Product is already ${status}`);
      if (status === "published") {
        const report = runProductTests(record.product, await store.referenceData());
        if (!report.passed) return { ...json({ error: "Cannot republish: the product fails its tests", ...report }), isError: true };
        await store.saveTestReport(id, report);
      }
      const saved = status === "published" ? await store.publishCurrentVersion(id) : await store.setProductStatus(id, "unpublished");
      await audit("admin_set_product_status", id, { status, reason, owner_id: record.owner_id });
      await rederiveProduct(store, id);
      if (status === "unpublished") await emitProductEvent(store, id, "product.unpublished");
      return json(saved);
    },
  );

  server.registerTool(
    "audit_log",
    {
      title: "Audit log",
      description: "Admin: recent admin actions, newest first, with who did them.",
      inputSchema: { limit: z.number().int().min(1).max(500).default(100) },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => json(await store.auditLog(limit)),
  );
}
