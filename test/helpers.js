import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizeModel } from "../dist/regulatory.js";
import { RepoOwnershipService } from "../dist/repo-ownership.js";

// Mynt ships no catalogue; tests seed this fixture (with the regions and categories it implies).
export const CATALOG = JSON.parse(readFileSync(new URL("./fixtures/catalog.json", import.meta.url), "utf8"));

// People's git-host tokens are sealed with the vault key.
process.env.MYNT_VAULT_KEY ??= randomBytes(32).toString("base64");

// A stand-in git host for people's own authorization: the code a person comes back with is their login, and who can
// push where is `push(login, repository)` (everyone everywhere by default). `revoked` logins' tokens stop working.
export function fakeGitHost(push = () => true) {
  const host = {
    name: "fake",
    push,
    revoked: new Set(),
    checks: [],
    authorizeUrl: (state, redirect) => `https://git.example/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirect)}`,
    async exchange(code) {
      return { access_token: `user-token-${code}`, refresh_token: null, expires_at: null, login: code };
    },
    async refresh() {
      throw new Error("no refresh");
    },
    async canPush(token, repository) {
      const login = token.replace(/^user-token-/, "");
      host.checks.push({ login, repository });
      if (host.revoked.has(login)) return "unauthorized";
      return host.push(login, repository);
    },
  };
  return host;
}

// Who may push where, on `db`, with a fake git host; `link(user)` connects the user's git account as their name.
export async function gitOwnership(db, host = fakeGitHost()) {
  const ownership = await RepoOwnershipService.open(db, host, "https://mynt.example.com");
  const link = async (user, login = user.name) => {
    const { authorize_url } = await ownership.begin(user.id);
    await ownership.complete(new URL(authorize_url).searchParams.get("state"), login);
  };
  return { ownership, host, link };
}

// Gives `user` a firm holding a verified licence for `action` on `category` in `region`, with a
// matching licence type in the regulatory model. Mutates `user.entity_id` so servers built for that
// user see the firm.
export async function licensed(store, user, { region = "IN", category = "deposits", action = "issuance" } = {}) {
  if (!user.entity_id) {
    const entity = await store.createEntity(user.id, { name: `${user.name} Ltd`, registration_numbers: {}, regions: [region] });
    await store.setUserEntity(user.id, entity.id);
    user.entity_id = entity.id;
  }
  const regulatorId = `test_${category}_${action}`.replace(/[^a-z0-9_]/g, "_");
  const regionRow = (await store.referenceData(true)).regions.find((r) => r.code === region);
  const model = normalizeModel(regionRow.regulatory);
  const productTypeId = `${regulatorId}_pt`;
  await store.upsertRegulatedProductType(region, { id: productTypeId, name: category, description: "", type_id: category, actions: [action] });
  const regulator = {
    id: regulatorId,
    name: `Test regulator for ${category}`,
    scope: { product_types: [{ id: productTypeId, name: category, description: "", type_id: category, action: [action] }], customer_personas: [] },
    license_types: [
      {
        _id: "lic",
        name: `Licence to ${action} ${category}`,
        scope: "",
        application_procedure: [],
        grc: {
          registers: { obligations: [], reporting_disclosure_filings: [], risks: [], controls: [], inspection_events: [] },
          repositories: { regulatory_communications: [], enforcement_actions: [], press_releases: [], policies: [], risk_models: [], inspection_history: [] },
          allowed_product_types: [{ id: productTypeId, actions: [action] }],
          allowed_customer_segments: [],
          mandatory_stakeholders: { internal: [], external: [] },
        },
      },
    ],
  };
  await store.setRegulatoryModel(region, { ...model, regulators: [...model.regulators.filter((r) => r.id !== regulatorId), regulator] });
  const held = await store.registerLicense(user.id, {
    entity_id: user.entity_id,
    region,
    regulator_id: regulatorId,
    license_id: "lic",
    registration_number: "TEST-001",
    valid_from: null,
    valid_to: null,
  });
  await store.reviewLicense(held.id, "verified", user.id, "test");
  return held;
}
