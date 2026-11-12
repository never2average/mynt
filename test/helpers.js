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
    revokedGrants: [],
    checks: [],
    refreshes: [],
    // The host's answer to a refresh: a new token (default), or an error to throw.
    refreshWith: null,
    authorizeUrl: (state, redirect, challenge) =>
      `https://git.example/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${challenge}&code_challenge_method=S256`,
    // The code a person comes back with is their login; the verifier is kept to check PKCE.
    async exchange(code, redirect, verifier) {
      host.lastVerifier = verifier;
      return { access_token: `user-token-${code}`, refresh_token: `refresh-${code}`, expires_at: null, login: code, user_id: `id-${code}` };
    },
    async refresh(refreshToken) {
      host.refreshes.push(refreshToken);
      if (host.refreshWith instanceof Error) throw host.refreshWith;
      const login = refreshToken.replace(/^refresh-/, "").replace(/-\d+$/, "");
      return { access_token: `user-token-${login}`, refresh_token: `refresh-${login}-${host.refreshes.length}`, expires_at: new Date(Date.now() + 8 * 3600e3).toISOString(), login, user_id: `id-${login}` };
    },
    async canPush(token, repository) {
      const login = token.replace(/^user-token-/, "");
      host.checks.push({ login, repository, token });
      if (host.revoked.has(login)) return "unauthorized";
      return host.push(login, repository);
    },
    async revoke(token) {
      host.revokedGrants.push(token);
    },
  };
  return host;
}

// Who may push where, on `db`, with a fake git host; `link(user)` links the user's git account (as their name) the
// way a person does: Mynt's start link, the host's callback in the same browser, then their own confirmation.
export async function gitOwnership(db, host = fakeGitHost()) {
  const ownership = await RepoOwnershipService.open(db, host, "https://mynt.example.com");
  const link = async (user, login = user.name) => {
    const { link: start } = await ownership.begin(user.id);
    const state = new URL(start).searchParams.get("state");
    const { cookie } = await ownership.startRedirect(state);
    const { confirm_code } = await ownership.callback(state, login, cookie);
    await ownership.confirm(user.id, confirm_code);
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
