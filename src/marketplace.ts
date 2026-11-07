import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BuildTermsSchema, productsAnsweredBy } from "./access.js";
import { lintCampaign } from "./gtm.js";
import { folder, folderOf, GrcRecordInputSchema, reconcileEntityGrc, validateGrcRecord } from "./entity-grc.js";
import { EntityFactsSchema, PartyInputSchema, reconcileEntity, validateParty } from "./parties.js";
import { driftSweep } from "./pins.js";
import { vendorDriftSweep } from "./vendors.js";
import { licenceJurisdictions, normalizeModel, SUBDIVISION } from "./regulatory.js";
import { emitProductEvent, emitRequestEvent } from "./runtime.js";
import { ACCESS_MODES, type AccessRequest, type Store, type User } from "./store.js";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

// Innovators (licensed firms): their entity and licences, who may build on their products, and the
// inbox of developers' requests.
export function registerMarketplaceTools(server: McpServer, store: Store, user: User) {
  const audit = (action: string, target: string, details: unknown = {}) => store.audit(user.id, action, target, details);
  const answered = async () => productsAnsweredBy(store, user);
  const answersFor = async (productId: string) => (await answered()).find((p) => p.product.id === productId);
  // The user record can be stale after create_entity in the same session.
  const me = async () => (await store.getUser(user.id)) ?? user;

  // ---- entity and licences ----

  registerFirmTools(server, store, user);

  server.registerTool(
    "create_entity",
    {
      title: "Register your firm",
      description:
        "Innovator: register the legal entity you act for (once), as typed facts: legal form, incorporation (lowercase ISO codes, e.g. { country: 'in', subdivision: 'in-mh' }) and identifiers ({ scheme: 'in_cin' | 'lei' | …, value }). Its licences let you publish products; its party roster (add_party) says who stands behind them.",
      inputSchema: {
        name: z.string().min(1),
        ...EntityFactsSchema,
        registration_numbers: z.record(z.string(), z.string()).default({}).describe("Deprecated: use identifiers"),
        regions: z.array(z.string()).default([]),
      },
    },
    async (e) => {
      if ((await me()).entity_id) return fail("You already belong to an entity; see get_my_entity");
      const entity = await store.createEntity(user.id, e);
      await store.setUserEntity(user.id, entity.id);
      user.entity_id = entity.id;
      await audit("create_entity", entity.id, { name: entity.name });
      return json(entity);
    },
  );

  server.registerTool(
    "file_grc_record",
    {
      title: "File a record in your GRC folder",
      description:
        "Innovator: file a record in your entity's GRC folder, or in a party's folder (party_id), laid out like the GRC of the licences you hold. Registers: obligations (compliance status, owner party), reporting_disclosure_filings (period, status, filed_on), risks (inherent and residual rating), controls and inspection_events (records following the licence's template fields). Repositories: regulatory_communications, enforcement_actions and press_releases ({ title, date, url, summary }), and policies, risk_models and inspection_history (following the template fields). Records answering the regulator name licence_id and ref (the obligation, filing, risk or template id; see get_regulator). Owners and approvers must be active parties on your roster. Filing the same key again supersedes the current record; history is kept.",
      inputSchema: GrcRecordInputSchema,
    },
    async (input) => {
      const { entity_id } = await me();
      if (!entity_id) return fail("You don't belong to an entity yet; create one with create_entity");
      const { errors, record, key } = await validateGrcRecord(store, entity_id, input);
      if (errors.length) return { ...json({ error: "The record can't be filed", errors }), isError: true };
      const filed = await store.fileGrcRecord(user.id, {
        entity_id,
        party_id: input.party_id ?? null,
        product_id: input.product_id ?? null,
        licence_id: input.licence_id ?? null,
        section: input.section,
        ref: input.ref ?? null,
        key,
        record,
      });
      await audit("file_grc_record", filed.id, { entity_id, party_id: filed.party_id, section: filed.section, ref: filed.ref, key });
      return json({ ...filed, folder: folderOf(input.section) });
    },
  );

  server.registerTool(
    "get_grc_folder",
    {
      title: "Your GRC folder",
      description:
        "Innovator: your entity's GRC folder (registers and repositories, current records), one party's (party_id) or one product's (product_id: where its risk models' governance lives), with each held licence's GRC matched against it: what's answered and the gaps (no record, an owner who doesn't fill the stakeholder the regulator makes accountable, non-compliance). history: true includes superseded records.",
      inputSchema: { party_id: z.string().uuid().optional(), product_id: z.string().optional(), history: z.boolean().default(false) },
      annotations: { readOnlyHint: true },
    },
    async ({ party_id, product_id, history }) => {
      const { entity_id } = await me();
      if (!entity_id) return fail("You don't belong to an entity yet; create one with create_entity");
      if (party_id && (await store.getParty(party_id))?.entity_id !== entity_id) return fail(`No party '${party_id}' on your entity's roster`);
      const all = await store.grcRecords(entity_id, { history });
      if (product_id && (await store.getProduct(product_id))?.entity_id !== entity_id) return fail(`No product '${product_id}' of your entity`);
      const records = party_id ? all.filter((r) => r.party_id === party_id) : product_id ? all.filter((r) => r.product_id === product_id) : all.filter((r) => !r.party_id && !r.product_id);
      return json({
        entity_id,
        party_id: party_id ?? null,
        product_id: product_id ?? null,
        ...folder(records),
        ...(history ? { history: records.filter((r) => r.status === "superseded") } : {}),
        reconciliation: await reconcileEntityGrc(store, entity_id),
      });
    },
  );

  server.registerTool(
    "set_entity_facts",
    {
      title: "Update your firm's facts",
      description: "Innovator: set your entity's legal form, incorporation or identifiers (each replaces what's there). Products resting on it are re-checked.",
      inputSchema: EntityFactsSchema,
    },
    async (facts) => {
      const { entity_id } = await me();
      if (!entity_id) return fail("You don't belong to an entity yet; create one with create_entity");
      const entity = await store.setEntityFacts(entity_id, facts);
      await audit("set_entity_facts", entity_id, facts);
      return json({ ...entity, drifted_products: await driftSweep(store, entity_id) });
    },
  );

  server.registerTool(
    "add_party",
    {
      title: "Add a party to your firm's roster",
      description:
        "Innovator: add who fills a role at your entity: an internal person or an external legal entity, the mandatory stakeholders they fill on the licences you hold (fills: licence id + stakeholder id from the licence type's mandatory_stakeholders, see get_regulator), facts for the stakeholders' qualification criteria, and for counterparties the relationship. Products can only name parties on this roster. get_my_entity shows each licence's stakeholders reconciled against it.",
      inputSchema: PartyInputSchema,
    },
    async (p) => {
      const { entity_id } = await me();
      if (!entity_id) return fail("You don't belong to an entity yet; create one with create_entity");
      const errors = await validateParty(store, entity_id, p);
      if (errors.length) return { ...json({ error: "The party can't be added", errors }), isError: true };
      let legalEntityId = p.legal_entity_id ?? null;
      if (p.kind === "external" && p.new_legal_entity) {
        const created = await store.createEntity(user.id, { ...p.new_legal_entity, registration_numbers: {}, regions: [] });
        await audit("create_entity", created.id, { name: created.name, as_party_of: entity_id });
        legalEntityId = created.id;
      }
      const party = await store.addParty(user.id, {
        entity_id,
        kind: p.kind,
        person: p.kind === "internal" ? { name: p.person!.name, identifiers: p.person!.identifiers } : null,
        legal_entity_id: p.kind === "external" ? legalEntityId : null,
        attributes: p.attributes,
        fills: p.fills,
        relationship: p.relationship ?? null,
        since: p.since ?? null,
      });
      await audit("add_party", party.id, { entity_id, kind: party.kind, fills: party.fills.length });
      return json({ ...party, drifted_products: await driftSweep(store, entity_id) });
    },
  );

  server.registerTool(
    "end_party",
    {
      title: "End a party's role at your firm",
      description:
        "Innovator: record that a party no longer fills its role (a person left, an agreement ended). Parties aren't edited: to change one, end it and add the new one. Published products bound to it drift and pause new sales until a new version is published.",
      inputSchema: { party_id: z.string(), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD; today by default") },
      annotations: { destructiveHint: true },
    },
    async ({ party_id, until }) => {
      const { entity_id } = await me();
      const party = await store.getParty(party_id);
      if (!entity_id || party?.entity_id !== entity_id) return fail(`No party '${party_id}' on your entity's roster`);
      if (party.status === "ended") return fail("That party has already ended");
      const ended = await store.endParty(party_id, until ?? new Date().toISOString().slice(0, 10));
      await audit("end_party", party_id, { entity_id, until: ended.until });
      return json({ ...ended, drifted_products: await driftSweep(store, entity_id) });
    },
  );

  // ---- who may build on a product ----

  server.registerTool(
    "set_product_access",
    {
      title: "Open a product to developers",
      description:
        "Innovator: set who may build on one of your products. open: any developer can publish experiences that meet your terms; approval: they build now and go live when you approve; private: only developers you invite. Terms set what experiences may do and must show.",
      inputSchema: { id: z.string(), access_mode: z.enum(ACCESS_MODES), build_terms: BuildTermsSchema.optional() },
    },
    async ({ id, access_mode, build_terms }) => {
      const record = await answersFor(id);
      if (!record) return fail(`No product of yours with id '${id}'`);
      const terms = build_terms ?? BuildTermsSchema.parse(record.build_terms ?? {});
      const saved = await store.setProductAccess(id, access_mode, terms);
      await audit("set_product_access", id, { access_mode, terms });
      return json({ id, access_mode: saved.access_mode, build_terms: saved.build_terms });
    },
  );

  server.registerTool(
    "list_requests",
    {
      title: "Developer requests inbox",
      description: "Innovator: developers' requests to build on, or launch campaigns over, your products, with the app or campaign behind each.",
      inputSchema: {
        status: z.enum(["pending", "approved", "rejected", "revoked"]).default("pending"),
        kind: z.enum(["product_access", "campaign_launch"]).optional(),
        product_id: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status, kind, product_id }) => {
      const ids = (await answered()).map((p) => p.product.id).filter((id) => !product_id || id === product_id);
      const requests = (await store.requestsForProducts(ids)).filter((r) => r.status === status && (!kind || r.kind === kind));
      return json(await Promise.all(requests.map(describe)));
    },
  );

  const describe = async (r: AccessRequest) => {
    const requester = await store.getUser(r.requester_id);
    const app = r.app_id ? await store.getApp(r.app_id) : undefined;
    const campaign = r.campaign_id ? await store.getCampaign(r.campaign_id) : undefined;
    return {
      ...r,
      requester: requester && { id: requester.id, name: requester.name, email: requester.email },
      app: app && { id: app.id, name: app.name, description: app.description, audience: app.audience, actions: app.actions, disclosures: app.disclosures, status: app.status },
      campaign: campaign && { id: campaign.id, name: campaign.name, channels: campaign.channels, variants: campaign.variants, status: campaign.status },
    };
  };

  server.registerTool(
    "review_request",
    {
      title: "Approve or reject a developer request",
      description:
        "Innovator: decide a request in your inbox. Approving access lets the app go live with your product once it meets your terms; approving a campaign launch puts the campaign live once every product's innovator has approved.",
      inputSchema: { request_id: z.string(), decision: z.enum(["approve", "reject"]), note: z.string().optional() },
    },
    async ({ request_id, decision, note }) => {
      const r = await store.getRequest(request_id);
      if (!r || !(await answersFor(r.product_id))) return fail(`No request '${request_id}' for your products`);
      if (r.status !== "pending") return fail(`Request is already ${r.status}`);
      const decided = await store.decideRequest(r.id, decision === "approve" ? "approved" : "rejected", user.id, note ?? null);
      await audit(`review_${r.kind}`, r.id, { decision, product_id: r.product_id });
      if (r.app_id) await emitRequestEvent(store, decided, "request.decided", { kind: r.kind, decision: decided.status, note: decided.decision_note });
      if (r.kind === "product_access" && decided.status === "approved") await emitRequestEvent(store, decided, "access.approved");
      let campaign_status: string | undefined;
      if (r.kind === "campaign_launch" && r.campaign_id) campaign_status = await settleCampaign(store, r.campaign_id);
      return json({ ...decided, ...(campaign_status ? { campaign_status } : {}) });
    },
  );

  server.registerTool(
    "invite_developer",
    {
      title: "Invite a developer to build on a product",
      description: "Innovator: let a developer build on one of your products (the way into a private product). Applies to all their apps.",
      inputSchema: { product_id: z.string(), developer_email: z.string().email(), note: z.string().default("") },
    },
    async ({ product_id, developer_email, note }) => {
      if (!(await answersFor(product_id))) return fail(`No product of yours with id '${product_id}'`);
      const dev = await store.userByEmail(developer_email);
      if (!dev) return fail(`${developer_email} hasn't signed in to Mynt yet`);
      const grant = await store.createRequest({ kind: "product_access", product_id, app_id: null, campaign_id: null, requester_id: dev.id, status: "approved", note, decided_by: user.id });
      await audit("invite_developer", product_id, { developer: dev.email });
      await emitRequestEvent(store, grant, "access.approved");
      return json(grant);
    },
  );

  server.registerTool(
    "revoke_access",
    {
      title: "Revoke a developer's access",
      description: "Innovator: withdraw an approval or invitation. Apps using it stop showing your product immediately.",
      inputSchema: { request_id: z.string(), reason: z.string().min(3) },
      annotations: { destructiveHint: true },
    },
    async ({ request_id, reason }) => {
      const r = await store.getRequest(request_id);
      if (!r || r.kind !== "product_access" || !(await answersFor(r.product_id))) return fail(`No access grant '${request_id}' for your products`);
      if (r.status !== "approved") return fail(`Request is ${r.status}, not approved`);
      const revoked = await store.decideRequest(r.id, "revoked", user.id, reason);
      await audit("revoke_access", r.id, { product_id: r.product_id, reason });
      await emitRequestEvent(store, revoked, "access.revoked", { reason });
      return json(revoked);
    },
  );

  server.registerTool(
    "suspend_product_experiences",
    {
      title: "Kill switch for a product",
      description:
        "Innovator: take one of your products out of every developer experience at once: makes it private, revokes all access grants, and pauses live campaigns that include it.",
      inputSchema: { product_id: z.string(), reason: z.string().min(3) },
      annotations: { destructiveHint: true },
    },
    async ({ product_id, reason }) => {
      const record = await answersFor(product_id);
      if (!record) return fail(`No product of yours with id '${product_id}'`);
      await store.setProductAccess(product_id, "private", record.build_terms);
      let revoked = 0;
      for (const r of await store.requestsForProducts([product_id])) {
        if (r.kind === "product_access" && (r.status === "approved" || r.status === "pending")) {
          await store.decideRequest(r.id, "revoked", user.id, reason);
          revoked++;
        }
      }
      let paused = 0;
      for (const c of await store.liveCampaigns()) {
        if (c.product_ids.includes(product_id)) {
          await store.saveCampaign({ ...c, status: "paused" });
          paused++;
        }
      }
      await audit("suspend_product_experiences", product_id, { reason, revoked, paused });
      await emitProductEvent(store, product_id, "product.suspended", { reason });
      return json({ product_id, access_mode: "private", grants_revoked: revoked, campaigns_paused: paused });
    },
  );

  server.registerTool(
    "list_experiences",
    {
      title: "Experiences built on my products",
      description: "Innovator: every developer app that uses your products, with its status and its access to each of your products.",
      inputSchema: { product_id: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ product_id }) => {
      const mine = (await answered()).map((p) => p.product.id).filter((id) => !product_id || id === product_id);
      const requests = await store.requestsForProducts(mine);
      const apps = (await store.allApps()).filter((a) => a.product_ids.some((id) => mine.includes(id)) && a.owner_id !== user.id);
      return json(
        await Promise.all(
          apps.map(async (a) => {
            const dev = await store.getUser(a.owner_id);
            return {
              id: a.id,
              name: a.name,
              status: a.status,
              developer: dev && { name: dev.name, email: dev.email },
              actions: a.actions,
              your_products: a.product_ids
                .filter((id) => mine.includes(id))
                .map((id) => {
                  const r = requests.find((x) => x.product_id === id && x.kind === "product_access" && (x.app_id === a.id || (x.app_id === null && x.requester_id === a.owner_id)));
                  return { product_id: id, access: r?.status ?? "none", request_id: r?.id };
                }),
            };
          }),
        ),
      );
    },
  );
}

// A campaign over other innovators' products goes live once all of them approve; any rejection sends
// it back to draft.
export async function settleCampaign(store: Store, campaignId: string): Promise<string> {
  const c = await store.getCampaign(campaignId);
  if (!c || c.status !== "pending_approval") return c?.status ?? "missing";
  const reqs = await store.requestsForCampaign(campaignId);
  if (reqs.some((r) => r.status === "rejected")) return (await store.saveCampaign({ ...c, status: "draft" })).status;
  if (reqs.some((r) => r.status === "pending")) return c.status;
  const products = (await Promise.all(c.product_ids.map((id) => store.getProduct(id)))).filter((r) => r?.status === "published").map((r) => r!.product);
  const lint = lintCampaign(c.variants, products);
  return (await store.saveCampaign({ ...c, status: lint.passed ? "live" : "draft", last_lint: lint })).status;
}

// A firm's own record and licences: innovators', and vendors' (whose firm an admin registers).
export function registerFirmTools(server: McpServer, store: Store, user: User) {
  const audit = (action: string, target: string, details: unknown = {}) => store.audit(user.id, action, target, details);
  const me = async () => (await store.getUser(user.id)) ?? user;
  const noFirm = user.roles.some((r) => r === "innovator" || r === "admin")
    ? "You don't belong to an entity yet; create one with create_entity"
    : "You don't belong to a firm yet; an admin adds you to one";

  server.registerTool(
    "get_my_entity",
    {
      title: "My firm",
      description: "Your firm: its members, its licences with their review status, its roster and GRC.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { entity_id } = await me();
      if (!entity_id) return fail(noFirm);
      const entity = await store.getEntity(entity_id);
      const members = (await store.entityMembers(entity_id)).map((m) => ({ id: m.id, name: m.name, email: m.email }));
      return json({
        ...entity,
        members,
        licenses: await store.licensesOf(entity_id),
        parties: await store.partiesOf(entity_id),
        reconciliation: await reconcileEntity(store, entity_id),
        grc: await reconcileEntityGrc(store, entity_id),
      });
    },
  );

  server.registerTool(
    "register_license",
    {
      title: "Register a licence your firm holds",
      description:
        "Record a licence your firm holds (a licence type from the regulatory model, see find_licenses) with its registration number and validity. A licence type issued per jurisdiction (e.g. a money transmitter licence in each US state) is registered once per jurisdiction, naming it. An admin verifies it before it counts.",
      inputSchema: {
        region: z.string(),
        regulator_id: z.string(),
        license_id: z.string(),
        jurisdiction: z
          .string()
          .regex(SUBDIVISION, "An ISO 3166-2 code, lowercase, e.g. 'us-ny'")
          .optional()
          .describe("The jurisdiction it was issued for (ISO 3166-2, e.g. 'us-ny'); required when its licence type is issued per jurisdiction, and only then"),
        registration_number: z.string().min(1),
        valid_from: z.string().optional().describe("YYYY-MM-DD"),
        valid_to: z.string().optional().describe("YYYY-MM-DD"),
      },
    },
    async (l) => {
      const { entity_id } = await me();
      if (!entity_id) return fail(noFirm);
      const region = (await store.referenceData(true)).regions.find((r) => r.code === l.region);
      const regulator = normalizeModel(region?.regulatory).regulators.find((r) => r.id === l.regulator_id);
      const type = regulator?.license_types.find((t) => t._id === l.license_id);
      if (!type) return fail(`No licence type '${l.license_id}' under '${l.regulator_id}' in ${l.region}; see get_regulator`);
      if (type.issued_per_jurisdiction) {
        if (!l.jurisdiction) return fail(`'${l.license_id}' is issued per jurisdiction: name the one it was issued for (one of ${(type.covers ?? []).join(", ")})`);
        if (!(type.covers ?? []).includes(l.jurisdiction)) return fail(`'${l.license_id}' isn't issued for '${l.jurisdiction}'; it covers ${(type.covers ?? []).join(", ")}`);
      } else if (l.jurisdiction) return fail(`'${l.license_id}' isn't issued per jurisdiction, so it takes no jurisdiction: it covers ${licenceJurisdictions(regulator, type, {}).map((j) => (j === "*" ? "the whole country" : j)).join(", ") || "nowhere by itself (other licences require it)"}`);
      const held = await store.registerLicense(user.id, { ...l, entity_id, jurisdiction: l.jurisdiction ?? null, valid_from: l.valid_from ?? null, valid_to: l.valid_to ?? null });
      await audit("register_license", held.id, { region: l.region, regulator: l.regulator_id, license: l.license_id, ...(l.jurisdiction ? { jurisdiction: l.jurisdiction } : {}) });
      // Re-registering sends a licence back for review, so products resting on it are re-checked.
      const drifted = [...(await driftSweep(store, entity_id)), ...(await vendorDriftSweep(store, { vendor_entity_id: entity_id }))];
      return json({ ...held, drifted_products: [...new Set(drifted)] });
    },
  );
}
