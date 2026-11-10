import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { licenseInForce, productsAnsweredBy } from "./access.js";
import { rederiveProduct } from "./derived.js";
import { firmLegitimacy, legitimacySummary } from "./firm-checks.js";
import { driftSweep } from "./pins.js";
import { compositionOf, productRegime } from "./regime.js";
import { coversJurisdiction, JURISDICTION, licenceJurisdictions, normalizeModel } from "./regulatory.js";
import { effectiveRoles, SPONSORSHIP_STATUSES, type HeldLicense, type Sponsorship, type Store, type User } from "./store.js";

// Licence providers: firms, added by hand by admins, that hold the licences (registered with register_license
// and verified by admins, as any firm's) and sponsor builders' products under them. A builder needn't be
// licensed: it names a licence provider as a component's provider ({ by: "sponsor", entity_id }, the provider's
// firm id shared out of band), asks it to sponsor that component (request_sponsorship), and the provider
// approves it under some of its held licences for some jurisdictions, declines it, or later revokes it. The
// regime then counts those licences for that component, there only (see regime.ts); the sponsorship is pinned
// at publish, so revoking it, or the provider's licence lapsing, drifts the product (see pins.ts).

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

// Where a held licence covers ("*": the whole country), by its type in the regulatory model.
export async function whereHeld(store: Store, h: HeldLicense) {
  const region = (await store.referenceData(true)).regions.find((r) => r.code === h.region);
  const regulator = normalizeModel(region?.regulatory).regulators.find((r) => r.id === h.regulator_id);
  return licenceJurisdictions(regulator, regulator?.license_types.find((l) => l._id === h.license_id), h);
}

// The component a sponsorship is for, from the working copy (or the live version when it's no longer there).
async function componentOf(store: Store, s: Pick<Sponsorship, "product_id" | "component_key">) {
  const record = await store.getProduct(s.product_id);
  if (!record) return { record: undefined, component: undefined };
  const component = record.components.find((c) => c.key === s.component_key) ?? (record.pins ? compositionOf(record, true).components.find((c) => c.key === s.component_key) : undefined);
  return { record, component };
}

// A sponsorship as either side sees it: the product, the component, both firms and the licences it's under.
async function describe(store: Store, s: Sponsorship) {
  const { record, component } = await componentOf(store, s);
  const [builder, provider] = await Promise.all([store.getEntity(s.builder_entity_id), store.getEntity(s.provider_entity_id)]);
  const licences = await Promise.all(s.licence_ids.map((id) => store.getHeldLicense(id)));
  return {
    ...s,
    product: record ? { id: record.product.id, name: record.product.name, status: record.status, drifted: Boolean(record.drift) } : { id: s.product_id, missing: true },
    component: component ? { key: component.key, country: component.country, primitive: component.primitive, action: component.action, offered_in: component.offered_in ?? null } : { key: s.component_key, missing: true },
    builder: { entity_id: s.builder_entity_id, name: builder?.name ?? null },
    provider: { entity_id: s.provider_entity_id, name: provider?.name ?? null },
    licences: licences.map((l, i) =>
      l
        ? { id: l.id, regulator_id: l.regulator_id, license_id: l.license_id, jurisdiction: l.jurisdiction, status: l.status, in_force: licenseInForce(l) }
        : { id: s.licence_ids[i], missing: true },
    ),
  };
}

// The licence provider's side: its licences, the requests it's asked to sponsor, and what it sponsors.
export function registerLicenseProviderTools(server: McpServer, store: Store, user: User) {
  const audit = (action: string, target: string, details: unknown = {}) => store.audit(user.id, action, target, details);
  const myEntity = async () => ((await store.getUser(user.id)) ?? user).entity_id;
  const noFirm = "You don't belong to a firm yet; an admin adds your firm (register_firm) and you to it (add_entity_member)";
  const mine = async (id: string) => {
    const entity = await myEntity();
    const s = entity ? await store.getSponsorship(id) : undefined;
    return s && s.provider_entity_id === entity ? s : undefined;
  };

  server.registerTool(
    "list_my_licenses",
    {
      title: "Licences your firm holds",
      description:
        "Licence provider: the licences your firm holds (register_license; an admin verifies each), whether each is in force, where it covers, and the approved sponsorships under it. Builders name your firm id to ask you to sponsor their products: it's in get_my_entity.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const entity = await myEntity();
      if (!entity) return fail(noFirm);
      const approved = await store.sponsorships({ provider_entity_id: entity, status: "approved" });
      const held = await store.licensesOf(entity);
      return json({
        entity_id: entity,
        licences: await Promise.all(
          held.map(async (h) => ({
            ...h,
            in_force: licenseInForce(h),
            covers: (await whereHeld(store, h)).map((j) => (j === "*" ? h.region.toLowerCase() : j)),
            sponsorships: approved.filter((s) => s.licence_ids.includes(h.id)).map((s) => s.id),
          })),
        ),
      });
    },
  );

  server.registerTool(
    "list_sponsorship_requests",
    {
      title: "Requests to sponsor products",
      description:
        "Licence provider: builders' requests to sponsor a component of their product under your licences (pending by default), each with the product, the component (primitive, action, country, where it's offered), the jurisdictions asked for, which of your verified licences grant that component, and your firm's legitimacy: whether Mynt's public checks (GLEIF LEI, FinCEN MSB) show it's a real company, which approving needs.",
      inputSchema: { status: z.enum(SPONSORSHIP_STATUSES).default("pending") },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => {
      const entity = await myEntity();
      if (!entity) return fail(noFirm);
      const held = await store.licensesOf(entity);
      // Whether your firm may sponsor at all: Mynt's public checks that it's a real company (see firm-checks.ts).
      const legitimacy = legitimacySummary(await firmLegitimacy(store, entity));
      const out = [];
      for (const s of await store.sponsorships({ provider_entity_id: entity, status })) {
        const d = await describe(store, s);
        const { record } = await componentOf(store, s);
        // The licence types that grant the component, from its regime, matched against what this firm holds.
        let granting: { id: string; regulator_id: string; license_id: string; jurisdiction: string | null; in_force: boolean }[] = [];
        if (record) {
          const regime = await productRegime(store, record).catch(() => null);
          const row = regime?.regions.flatMap((r) => r.components).find((c) => c.key === s.component_key);
          const types = new Set((row?.licences ?? []).map((l) => `${l.regulator_id}/${l.license_id}`));
          granting = held
            .filter((h) => types.has(`${h.regulator_id}/${h.license_id}`) && h.region === row?.region)
            .map((h) => ({ id: h.id, regulator_id: h.regulator_id, license_id: h.license_id, jurisdiction: h.jurisdiction, in_force: licenseInForce(h) }));
        }
        out.push({ ...d, your_licences_granting_it: granting, your_firm_legitimacy: legitimacy });
      }
      return json(out);
    },
  );

  server.registerTool(
    "approve_sponsorship",
    {
      title: "Sponsor a product under your licences",
      description:
        "Licence provider: approve a pending request to sponsor a builder's product component, naming the held licences it's under (verified and in force; licences that only back others, like a federal registration a state licence requires, are counted automatically and aren't named) and the jurisdictions you sponsor it in (ISO 3166-2 codes like 'us-ny', or the country code for the whole country; by default those asked for that the licences cover). The component is then covered there only, by your licence, and your roster must fill the stakeholders that licence mandates. Your firm must first pass Mynt's public checks that it's a real company (see get_my_entity's legitimacy). Revoke it later with revoke_sponsorship.",
      inputSchema: {
        sponsorship_id: z.string(),
        licence_ids: z.array(z.string().uuid()).min(1).describe("Your held licences to sponsor it under (see list_my_licenses)"),
        jurisdictions: z.array(z.string().regex(JURISDICTION, "An ISO 3166-2 code, lowercase, e.g. 'us-ny', or the country code ('us')")).min(1).optional(),
        note: z.string().optional(),
      },
    },
    async ({ sponsorship_id, licence_ids, jurisdictions, note }) => {
      const s = await mine(sponsorship_id);
      if (!s) return fail(`No sponsorship request '${sponsorship_id}' to your firm`);
      if (s.status !== "pending") return fail(`The request is ${s.status}, not pending`);
      // Only a firm Mynt has shown to be a real company sponsors (SPONSOR_LEGITIMACY_RULE; see firm-checks.ts).
      const legitimacy = await firmLegitimacy(store, s.provider_entity_id);
      if (!legitimacy?.passes)
        return {
          ...json({
            error: "Your firm can't sponsor products until Mynt's public checks show it's a real company",
            rule: legitimacy?.rule_text ?? null,
            reasons: legitimacy?.reasons ?? [],
            next: "Record your firm's LEI (set_entity_facts identifiers: { scheme: 'lei', value }) and ask a Mynt admin to run the checks (run_firm_checks); see get_my_entity",
          }),
          isError: true,
        };
      const { record, component } = await componentOf(store, s);
      if (!record || !component) return fail(`The product '${s.product_id}' no longer has a component '${s.component_key}'`);
      const country = component.country;
      const errors: string[] = [];
      const where = new Map<string, string[]>();
      for (const id of [...new Set(licence_ids)]) {
        const h = await store.getHeldLicense(id);
        if (!h || h.entity_id !== s.provider_entity_id) {
          errors.push(`your firm holds no licence '${id}'`);
          continue;
        }
        if (h.region !== country.toUpperCase()) errors.push(`licence '${id}' (${h.license_id}) is held in ${h.region}, not ${country.toUpperCase()}`);
        if (!licenseInForce(h)) errors.push(`licence '${id}' (${h.license_id}) isn't verified and in force`);
        const covers = await whereHeld(store, h);
        if (!covers.length) errors.push(`licence '${id}' (${h.license_id}) covers nowhere by itself: it backs other licences, and counts automatically alongside them; name the licences that cover the jurisdictions`);
        where.set(id, covers);
      }
      if (errors.length) return { ...json({ error: "The sponsorship can't be approved", errors }), isError: true };
      const covered = (j: string) => [...where.values()].some((w) => (j === country ? w.includes("*") : coversJurisdiction(w, j)));
      const asked = s.requested_jurisdictions.length ? s.requested_jurisdictions : [country];
      const chosen = jurisdictions ? [...new Set(jurisdictions)] : asked.filter(covered);
      for (const j of chosen) {
        if (j !== country && !j.startsWith(`${country}-`)) errors.push(`'${j}' isn't in ${country.toUpperCase()}, where the component is regulated`);
        else if (!asked.includes(j) && !asked.includes(country)) errors.push(`'${j}' wasn't asked for (asked: ${asked.join(", ")})`);
        else if (!covered(j)) errors.push(`none of the named licences covers ${j === country ? `the whole of ${country.toUpperCase()}` : j}`);
      }
      if (!chosen.length) errors.push(`none of the named licences covers what was asked for (${asked.join(", ")})`);
      if (errors.length) return { ...json({ error: "The sponsorship can't be approved", errors }), isError: true };
      const approved = await store.decideSponsorship(s.id, { status: "approved", decided_by: user.id, note: note ?? null, licence_ids: [...where.keys()], jurisdictions: chosen });
      await audit("approve_sponsorship", s.id, { product_id: s.product_id, component: s.component_key, licence_ids: approved.licence_ids, jurisdictions: chosen });
      await rederiveProduct(store, s.product_id);
      return json(await describe(store, approved));
    },
  );

  server.registerTool(
    "decline_sponsorship",
    {
      title: "Decline to sponsor a product",
      description: "Licence provider: decline a pending request to sponsor a builder's product component, saying why.",
      inputSchema: { sponsorship_id: z.string(), reason: z.string().min(3) },
    },
    async ({ sponsorship_id, reason }) => {
      const s = await mine(sponsorship_id);
      if (!s) return fail(`No sponsorship request '${sponsorship_id}' to your firm`);
      if (s.status !== "pending") return fail(`The request is ${s.status}, not pending`);
      const declined = await store.decideSponsorship(s.id, { status: "declined", decided_by: user.id, note: reason });
      await audit("decline_sponsorship", s.id, { product_id: s.product_id, component: s.component_key, reason });
      return json(await describe(store, declined));
    },
  );

  server.registerTool(
    "revoke_sponsorship",
    {
      title: "Stop sponsoring a product",
      description:
        "Licence provider: withdraw an approved sponsorship. The component loses your licences' coverage, so a published product resting on it drifts (new sales pause, naming the jurisdictions it covered) until its builder finds cover and publishes a new version.",
      inputSchema: { sponsorship_id: z.string(), reason: z.string().min(3) },
      annotations: { destructiveHint: true },
    },
    async ({ sponsorship_id, reason }) => {
      const s = await mine(sponsorship_id);
      if (!s) return fail(`No sponsorship '${sponsorship_id}' by your firm`);
      if (s.status !== "approved") return fail(`The sponsorship is ${s.status}, not approved`);
      const revoked = await store.decideSponsorship(s.id, { status: "revoked", decided_by: user.id, note: reason });
      await audit("revoke_sponsorship", s.id, { product_id: s.product_id, component: s.component_key, reason });
      const drifted = await driftSweep(store, s.provider_entity_id);
      await rederiveProduct(store, s.product_id);
      return json({ ...(await describe(store, revoked)), drifted_products: drifted });
    },
  );

  server.registerTool(
    "list_sponsored_products",
    {
      title: "Products you sponsor",
      description: "Licence provider: every approved sponsorship by your firm: the product (and whether it's live or drifted), the component, the licences and the jurisdictions.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const entity = await myEntity();
      if (!entity) return fail(noFirm);
      return json(await Promise.all((await store.sponsorships({ provider_entity_id: entity, status: "approved" })).map((s) => describe(store, s))));
    },
  );
}

// The builder's side: ask a licence provider to sponsor a component, and see where each request stands.
export function registerSponsorshipBuilderTools(server: McpServer, store: Store, user: User) {
  const audit = (action: string, target: string, details: unknown = {}) => store.audit(user.id, action, target, details);
  const me = async () => (await store.getUser(user.id)) ?? user;

  server.registerTool(
    "request_sponsorship",
    {
      title: "Ask a licence provider to sponsor a product",
      description:
        "Ask a licence provider (by its firm id, which it shares with you) to sponsor one component of your product under its licences, so you needn't hold them. First make the provider the component's provider (set_product_composition: provider { by: 'sponsor', entity_id }, or a v2 definition's component_provided_by to { kind: 'sponsor', id }). jurisdictions defaults to where the component is offered (offered_in), or the country as a whole. Once it approves, the component is covered where it approved; see list_my_sponsorships.",
      inputSchema: {
        product_id: z.string(),
        component_key: z.string(),
        provider_entity_id: z.string().uuid(),
        jurisdictions: z.array(z.string().regex(JURISDICTION, "An ISO 3166-2 code, lowercase, e.g. 'us-ny', or the country code ('us')")).min(1).optional(),
        note: z.string().optional(),
      },
    },
    async ({ product_id, component_key, provider_entity_id, jurisdictions, note }) => {
      const { entity_id } = await me();
      if (!entity_id) return fail("You don't belong to an entity yet; create one with create_entity");
      const record = (await productsAnsweredBy(store, await me())).find((p) => p.product.id === product_id);
      if (!record || record.entity_id !== entity_id) return fail(`No product of your firm with id '${product_id}'`);
      const component = record.components.find((c) => c.key === component_key);
      if (!component) return fail(`Product '${product_id}' has no component '${component_key}' in its working copy`);
      if (component.provider?.by !== "sponsor" || component.provider.entity_id !== provider_entity_id)
        return fail(`Component '${component_key}' isn't provided by that licence provider: set its provider to { by: 'sponsor', entity_id: '${provider_entity_id}' } first`);
      if (provider_entity_id === entity_id) return fail("Your own firm can't sponsor your product");
      const provider = await store.getEntity(provider_entity_id);
      if (!provider) return fail(`No firm '${provider_entity_id}' on Mynt`);
      if (!(await store.entityMembers(provider_entity_id)).some((m) => effectiveRoles(m.roles).includes("license_provider")))
        return fail(`${provider.name} isn't a licence provider on Mynt`);
      const asked = [...new Set(jurisdictions ?? component.offered_in ?? [])];
      for (const j of asked) if (j !== component.country && !j.startsWith(`${component.country}-`)) return fail(`'${j}' isn't in ${component.country.toUpperCase()}, where '${component_key}' is regulated`);
      // One pending request at a time; an approved sponsorship can be extended by asking again for more jurisdictions.
      const open = (await store.sponsorships({ product_id, provider_entity_id, status: "pending" })).find((s) => s.component_key === component_key);
      if (open) return fail(`There's already a pending request '${open.id}' to ${provider.name} for '${component_key}'`);
      const s = await store.requestSponsorship(user.id, { product_id, component_key, builder_entity_id: entity_id, provider_entity_id, requested_jurisdictions: asked, note: note ?? null });
      await audit("request_sponsorship", s.id, { product_id, component: component_key, provider_entity_id, jurisdictions: asked });
      return json(await describe(store, s));
    },
  );

  server.registerTool(
    "list_my_sponsorships",
    {
      title: "Your sponsorship requests",
      description: "Your firm's requests to licence providers to sponsor its products' components, with each one's status (pending, approved, declined, revoked), the licences and the jurisdictions approved.",
      inputSchema: { product_id: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ product_id }) => {
      const { entity_id } = await me();
      if (!entity_id) return fail("You don't belong to an entity yet; create one with create_entity");
      return json(await Promise.all((await store.sponsorships({ builder_entity_id: entity_id, product_id })).map((s) => describe(store, s))));
    },
  );
}
