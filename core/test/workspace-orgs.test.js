import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { createMcpHttpServer } from "../dist/http.js";
import { Store } from "../dist/store.js";
import { releaseLapsedInvites, setOrgDirectory } from "../dist/workspaces.js";
import { WorkspaceSync } from "../dist/workspace-sync.js";
import { ClerkOrgDirectory } from "../dist/clerk-orgs.js";
import { CATALOG } from "./helpers.js";

// The identity provider's organizations, in memory: what Mynt asks of it is recorded, and a test can make any call
// fail. Its state is what Mynt reads back on every event.
function fakeDirectory() {
  const d = {
    orgs: new Map(), // id -> { id, name, created_by, workspace_id }
    members: new Map(), // org id -> Map(subject -> role)
    emails: new Map(), // subject -> verified addresses
    invitations: [],
    calls: [],
    fail: {},
    nextId: null,
    log(name, ...a) {
      d.calls.push([name, ...a]);
      if (d.fail[name]) throw new Error(`${name} failed`);
    },
    called: (name, ...a) => d.calls.some((c) => c[0] === name && a.every((x, i) => x === undefined || c[i + 1] === x)),
    async createOrg(name, createdBy, workspaceId) {
      d.log("createOrg", name, createdBy, workspaceId);
      const id = d.nextId ?? `org_${d.orgs.size + 1}_${randomUUID().slice(0, 4)}`;
      d.nextId = null;
      d.orgs.set(id, { id, name, created_by: createdBy, workspace_id: workspaceId });
      d.members.set(id, new Map([[createdBy, "admin"]]));
      return d.orgs.get(id);
    },
    // Made in the provider itself (its "create your first organization" step): no Mynt workspace behind it.
    providerOrg(id, name, createdBy) {
      d.orgs.set(id, { id, name, created_by: createdBy, workspace_id: null });
      d.members.set(id, new Map([[createdBy, "admin"]]));
      return d.orgs.get(id);
    },
    async getOrg(id) {
      d.log("getOrg", id);
      return d.orgs.get(id) ?? null;
    },
    async renameOrg(id, name) {
      d.log("renameOrg", id, name);
      d.orgs.get(id).name = name;
    },
    async deleteOrg(id) {
      d.log("deleteOrg", id);
      d.orgs.delete(id);
      d.members.delete(id);
    },
    async listOrgs(offset, limit) {
      d.log("listOrgs");
      const all = [...d.orgs.values()];
      return { orgs: all.slice(offset, offset + limit), total: all.length };
    },
    async listMemberships(id) {
      return [...(d.members.get(id) ?? new Map())].map(([subject, role]) => ({ subject, role }));
    },
    async getMembership(id, subject) {
      const role = d.members.get(id)?.get(subject);
      return role ? { subject, role } : null;
    },
    async userMemberships(subject) {
      return [...d.members].filter(([, ms]) => ms.has(subject)).map(([id, ms]) => ({ org: d.orgs.get(id), role: ms.get(subject) }));
    },
    async verifiedEmails(subject) {
      return d.emails.get(subject) ?? [];
    },
    async userByEmail(email) {
      const hits = [...d.emails].filter(([, es]) => es.includes(email));
      return hits.length === 1 ? hits[0][0] : null;
    },
    async addMember(id, subject, role) {
      d.log("addMember", id, subject, role);
      d.members.get(id).set(subject, role);
    },
    async setMemberRole(id, subject, role) {
      d.log("setMemberRole", id, subject, role);
      if (!d.members.get(id)?.has(subject)) throw new Error("not a member");
      d.members.get(id).set(subject, role);
    },
    async removeMember(id, subject) {
      d.log("removeMember", id, subject);
      d.members.get(id)?.delete(subject);
    },
    async invite(id, o) {
      d.log("invite", id, o);
      const inv = { id: `inv_${d.invitations.length + 1}`, org: id, status: "pending", ...o };
      d.invitations.push(inv);
      return { id: inv.id };
    },
    async getInvitation(org, id) {
      const i = d.invitations.find((x) => x.id === id && x.org === org);
      return i ? { id: i.id, status: i.status, email: i.email, metadata: i.metadata } : null;
    },
    async revokeInvitation(org, id) {
      d.log("revokeInvitation", org, id);
      const i = d.invitations.find((x) => x.id === id);
      if (i?.status === "pending") i.status = "revoked";
    },
    // Someone accepts an invitation with the provider: they're in its organization, with its role.
    acceptInProvider(invitationId, subject) {
      const i = d.invitations.find((x) => x.id === invitationId);
      i.status = "accepted";
      d.members.get(i.org).set(subject, i.role);
    },
    manageUrl: () => "https://accounts.example.test/organization",
  };
  return d;
}

async function setup() {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const dir = fakeDirectory();
  setOrgDirectory(dir);
  const sync = new WorkspaceSync(store, dir);
  const person = async (name, roles = ["developer"], { signedIn = true } = {}) => {
    const { user } = await store.createUser(name, roles);
    const email = `${name.toLowerCase()}@example.com`;
    const subject = `user_${name.toLowerCase()}`;
    await pg.query("UPDATE financial_products.users SET email = $2, clerk_user_id = $3 WHERE id = $1", [user.id, email, signedIn ? subject : null]);
    await pg.query("INSERT INTO financial_products.invites (email, roles, created_at, updated_at) VALUES ($1, $2, now(), now()) ON CONFLICT (email) DO NOTHING", [email, roles]);
    if (signedIn) dir.emails.set(subject, [email]);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, { ...user, email }, { workspaceSync: sync }).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    const call = async (tool, args = {}) => {
      const res = await client.callTool({ name: tool, arguments: args });
      try {
        return JSON.parse(res.content[0].text);
      } catch {
        return { error: res.content[0].text };
      }
    };
    return { user, email, subject, call };
  };
  const q = async (s, p) => (await pg.query(s, p)).rows;
  const role = async (wsId, userId) => (await q("SELECT role FROM financial_products.workspace_members WHERE workspace_id = $1 AND user_id = $2", [wsId, userId]))[0]?.role ?? null;
  const ws = async (orgId) => (await q("SELECT id::text AS id, name, org_missing_at, archived_at, org_sync FROM financial_products.workspaces WHERE external_org_id = $1", [orgId]))[0];
  const wsById = async (id) => (await q("SELECT id::text AS id, name, external_org_id, org_missing_at, archived_at, archive_done_at, org_sync FROM financial_products.workspaces WHERE id = $1", [id]))[0];
  const audits = async (action) => await q("SELECT target, details FROM financial_products.audit_log WHERE action = $1", [action]);
  const roles = async (userId) => (await q("SELECT roles FROM financial_products.users WHERE id = $1", [userId]))[0].roles;
  const orgOf = async (wsId) => (await wsById(wsId)).external_org_id;
  const member = (orgId, subject) => w0.dir.members.get(orgId)?.get(subject) ?? null;
  const w0 = { pg, store, dir, sync, person, role, ws, wsById, audits, roles, q, orgOf };
  w0.member = member;
  w0.changed = (orgId, subject) => sync.handle({ type: "membership.changed", orgId, subject });
  return w0;
}

afterEach(() => setOrgDirectory(null));

// ---- making workspaces ----

test("creating a workspace makes its organization, tagged with the workspace; if the organization can't be made or linked, there's no workspace", async () => {
  const w = await setup();
  const ana = await w.person("Ana");
  const made = await ana.call("create_workspace", { name: "Team" });
  const orgId = await w.orgOf(made.id);
  assert.deepEqual(w.dir.orgs.get(orgId), { id: orgId, name: "Team", created_by: ana.subject, workspace_id: made.id });
  assert.equal(await w.role(made.id, ana.user.id), "owner");
  assert.equal((await w.wsById(made.id)).org_sync, "done");
  // The provider refuses: no workspace.
  w.dir.fail.createOrg = true;
  assert.match((await ana.call("create_workspace", { name: "Nope" })).error ?? "", /couldn't be made.*createOrg failed/);
  assert.equal((await w.q("SELECT count(*)::int AS n FROM financial_products.workspaces WHERE name = 'Nope'"))[0].n, 0);
  w.dir.fail.createOrg = false;
  // The organization is made but can't be linked (it's already another workspace's): it's deleted, and so is the row.
  w.dir.nextId = orgId;
  assert.ok((await ana.call("create_workspace", { name: "Twin" })).error);
  assert.ok(w.dir.called("deleteOrg", orgId));
  assert.equal((await w.q("SELECT count(*)::int AS n FROM financial_products.workspaces WHERE name = 'Twin'"))[0].n, 0);
});

test("the provider's event for an organization Mynt is still making links to that workspace rather than making another (create race)", async () => {
  const w = await setup();
  const ana = await w.person("Ana");
  // The event arrives between the organization's making and its linking.
  const realCreate = w.dir.createOrg;
  w.dir.createOrg = async (...a) => {
    const org = await realCreate(...a);
    await w.sync.handle({ type: "org.changed", orgId: org.id });
    return org;
  };
  const made = await ana.call("create_workspace", { name: "Raced" });
  assert.equal((await w.q("SELECT count(*)::int AS n FROM financial_products.workspaces"))[0].n, 1);
  assert.equal((await w.wsById(made.id)).org_sync, "done");
});

// ---- the webhook ----

const SECRET = `whsec_${Buffer.from("a-test-signing-secret-of-32-bytes!").toString("base64")}`;
// Signed as the Standard Webhooks spec says (what Clerk's webhooks use), independently of the library Mynt verifies with.
const sign = (secret, id, at, body) =>
  `v1,${createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64")).update(`${id}.${Math.floor(at.getTime() / 1000)}.${body}`).digest("base64")}`;

test("the webhook: a valid signature is applied once; a bad, unsigned or stale one is refused; it's off without its secret", async () => {
  const w = await setup();
  const ana = await w.person("Ana");
  w.dir.providerOrg("org_hook", "From the dashboard", ana.subject);
  process.env.CLERK_WEBHOOK_SECRET = SECRET;
  const http = createMcpHttpServer(w.store, null, { workspaceSync: w.sync }).listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const base = `http://127.0.0.1:${http.address().port}`;
  const send = async (event, { id = `msg_${randomUUID()}`, at = new Date(), secret = SECRET } = {}) => {
    const body = JSON.stringify(event);
    const res = await fetch(`${base}/webhooks/clerk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "svix-id": id, "svix-timestamp": String(Math.floor(at.getTime() / 1000)), "svix-signature": sign(secret, id, at, body) },
      body,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  try {
    const created = { type: "organization.created", data: { id: "org_hook", name: "From the dashboard", created_by: ana.subject } };
    assert.equal((await send(created, { id: "msg_once" })).status, 200);
    assert.ok(await w.ws("org_hook"), "its creator's workspace");
    assert.deepEqual((await send(created, { id: "msg_once" })).body, { duplicate: true }, "the same event again: handled once");
    assert.equal((await send(created, { secret: `whsec_${Buffer.from("not-the-secret-not-the-secret-xx").toString("base64")}` })).status, 400);
    assert.equal((await send(created, { at: new Date(Date.now() - 60 * 60_000) })).status, 400, "an old (replayed) signature");
    assert.equal((await fetch(`${base}/webhooks/clerk`, { method: "POST", body: JSON.stringify(created) })).status, 400, "unsigned");
    // A membership event carries only ids: Mynt reads the membership back.
    const ben = await w.person("Ben");
    w.dir.members.get("org_hook").set(ben.subject, "member");
    const m = { type: "organizationMembership.created", data: { organization: { id: "org_hook" }, public_user_data: { user_id: ben.subject }, role: "org:admin" } };
    assert.equal((await send(m)).status, 200);
    assert.equal(await w.role((await w.ws("org_hook")).id, ben.user.id), "member", "the provider's state (member), not the payload's (admin)");
    delete process.env.CLERK_WEBHOOK_SECRET;
    assert.equal((await send(created)).status, 404);
  } finally {
    delete process.env.CLERK_WEBHOOK_SECRET;
    http.closeAllConnections();
    http.close();
  }
});

// ---- platform roles are Mynt's ----

test("P1: syncing never undoes an admin's demotion (no Mynt role is granted by syncing)", async () => {
  const w = await setup();
  const dan = await w.person("Dan");
  await dan.call("create_workspace", { name: "Dan's" });
  await w.q("UPDATE financial_products.invites SET roles = '{consumer}', admin_roles_at = now() WHERE email = $1", [dan.email]);
  await w.q("UPDATE financial_products.users SET roles = '{consumer}' WHERE id = $1", [dan.user.id]);
  await w.sync.reconcileAll();
  await w.sync.reconcileUser(dan.user.id, dan.subject, true);
  assert.deepEqual(await w.roles(dan.user.id), ["consumer"]);
  assert.deepEqual((await w.store.getInvite(dan.email)).roles, ["consumer"]);
});

test("P2: a user making their own organization in the provider gets that workspace as its owner and nothing more; a stranger joining it isn't let onto Mynt", async () => {
  const w = await setup();
  const cy = await w.person("Cy", ["consumer"]);
  w.dir.providerOrg("org_self", "Mine", cy.subject);
  await w.sync.handle({ type: "org.changed", orgId: "org_self" });
  await w.changed("org_self", cy.subject);
  const mine = await w.ws("org_self");
  assert.equal(await w.role(mine.id, cy.user.id), "owner");
  assert.deepEqual(await w.roles(cy.user.id), ["consumer"]);
  // A stranger (not on Mynt) joins in the provider: a join request, no Mynt invite.
  w.dir.members.get("org_self").set("user_stranger", "admin");
  w.dir.emails.set("user_stranger", ["stranger@elsewhere.test"]);
  await w.changed("org_self", "user_stranger");
  assert.equal(await w.store.getInvite("stranger@elsewhere.test"), undefined);
  assert.deepEqual((await w.q("SELECT email FROM financial_products.workspace_join_requests")).map((r) => r.email), ["stranger@elsewhere.test"]);
});

test("P10/P11: someone on Mynt joining through the provider is a member only: an admin role there is put back, their Mynt roles stay", async () => {
  const w = await setup();
  const ana = await w.person("Ana");
  const cy = await w.person("Cy", ["consumer"]);
  const made = await ana.call("create_workspace", { name: "T" });
  const orgId = await w.orgOf(made.id);
  // P10: a "user" invite to another address of theirs, never accepted; they're added in the provider directly.
  await ana.call("invite_to_workspace", { workspace_id: made.id, email: "cy-work@example.com", role: "member", mynt_role: "user" });
  w.dir.members.get(orgId).set(cy.subject, "admin"); // P11: as an admin
  await w.changed(orgId, cy.subject);
  assert.equal(await w.role(made.id, cy.user.id), "member");
  assert.equal(w.member(orgId, cy.subject), "member", "the provider's admin role put back");
  assert.deepEqual(await w.roles(cy.user.id), ["consumer"]);
  // Raised to admin there later: put back again (workspace roles are raised in Mynt).
  w.dir.members.get(orgId).set(cy.subject, "admin");
  await w.changed(orgId, cy.subject);
  assert.equal(await w.role(made.id, cy.user.id), "member");
  assert.equal((await w.audits("workspace_role_restored")).length, 1);
});

// ---- Mynt invites accepted in the provider ----

test("a Mynt invite accepted with the provider (matched by its invitation's id) goes through Mynt's acceptance rules; a provider-made invitation claiming it doesn't", async () => {
  const w = await setup();
  const ana = await w.person("Ana");
  const cy = await w.person("Cy", ["consumer"]);
  const made = await ana.call("create_workspace", { name: "T" });
  const orgId = await w.orgOf(made.id);
  const inv = await ana.call("invite_to_workspace", { workspace_id: made.id, email: cy.email, role: "admin" });
  const sent = w.dir.invitations[0];
  assert.deepEqual(sent.metadata, { mynt_role: "developer", mynt_workspace_role: "admin", mynt_invite_id: inv.id });
  // A provider-made invitation to Eve, carrying Cy's Mynt invite id in its metadata.
  const eve = await w.person("Eve", ["consumer"]);
  await w.dir.invite(orgId, { email: eve.email, role: "admin", inviter: null, metadata: { mynt_invite_id: inv.id } });
  w.dir.acceptInProvider("inv_2", eve.subject);
  await w.sync.handle({ type: "invitation.accepted", orgId, invitationId: "inv_2" });
  await w.changed(orgId, eve.subject);
  assert.equal(await w.role(made.id, eve.user.id), "member", "a plain join");
  assert.deepEqual(await w.roles(eve.user.id), ["consumer"]);
  // Cy accepts the real one in the provider: Mynt's rules make them an admin and (a user's account) a developer.
  w.dir.acceptInProvider(sent.id, cy.subject);
  await w.sync.handle({ type: "invitation.accepted", orgId, invitationId: sent.id });
  assert.equal(await w.role(made.id, cy.user.id), "admin");
  assert.deepEqual((await w.roles(cy.user.id)).sort(), ["consumer", "developer"]);
  assert.ok((await w.q("SELECT accepted_at FROM financial_products.workspace_invites WHERE id = $1", [inv.id]))[0].accepted_at);
});

test("P7/P7b: a lapsed invite, or one whose sender can no longer invite to its role, gives nothing more than a plain join", async () => {
  const w = await setup();
  const ana = await w.person("Ana");
  const bo = await w.person("Bo");
  const ben = await w.person("Ben");
  const cal = await w.person("Cal");
  const made = await ana.call("create_workspace", { name: "T" });
  const orgId = await w.orgOf(made.id);
  // P7: an owner invite, 40 days old.
  const lapsed = await ana.call("invite_to_workspace", { workspace_id: made.id, email: ben.email, role: "owner" });
  await w.q("UPDATE financial_products.workspace_invites SET created_at = now() - interval '40 days' WHERE id = $1", [lapsed.id]);
  w.dir.acceptInProvider(w.dir.invitations[0].id, ben.subject);
  await w.sync.handle({ type: "invitation.accepted", orgId, invitationId: w.dir.invitations[0].id });
  assert.equal(await w.role(made.id, ben.user.id), "member");
  // P7b: Bo (an owner then) invites Cal as an owner, then is made a member.
  await ana.call("invite_to_workspace", { workspace_id: made.id, email: bo.email, role: "owner" });
  await bo.call("accept_workspace_invite", { invite_id: (await bo.call("list_my_invitations")).invitations[0].id });
  await bo.call("invite_to_workspace", { workspace_id: made.id, email: cal.email, role: "owner" });
  await ana.call("change_member_role", { workspace_id: made.id, user_id: bo.user.id, role: "member" });
  const calInv = w.dir.invitations.find((i) => i.email === cal.email);
  w.dir.acceptInProvider(calInv.id, cal.subject);
  await w.sync.handle({ type: "invitation.accepted", orgId, invitationId: calInv.id });
  assert.equal(await w.role(made.id, cal.user.id), "member");
  assert.equal(w.member(orgId, cal.subject), "member");
});

// ---- ownership is Mynt's ----

test("P3/P4: an owner removed or demoted in the provider is put back; nobody is made owner by syncing; a deleted organization that still exists changes nothing", async () => {
  const w = await setup();
  const ana = await w.person("Ana");
  const eve = await w.person("Eve");
  const made = await ana.call("create_workspace", { name: "Team" });
  const orgId = await w.orgOf(made.id);
  w.dir.members.get(orgId).set(eve.subject, "admin");
  await w.changed(orgId, eve.subject);
  assert.equal(await w.role(made.id, eve.user.id), "member");
  // A provider admin removes Ana (Mynt's owner): she's put back there.
  w.dir.members.get(orgId).delete(ana.subject);
  await w.changed(orgId, ana.subject);
  assert.equal(await w.role(made.id, ana.user.id), "owner");
  assert.equal(w.member(orgId, ana.subject), "admin");
  // ...or demotes her.
  w.dir.members.get(orgId).set(ana.subject, "member");
  await w.changed(orgId, ana.subject);
  assert.equal(w.member(orgId, ana.subject), "admin");
  assert.equal((await w.audits("workspace_owner_restored")).length, 2);
  // An organization-deleted event for an organization that still exists: nothing happens.
  await w.sync.handle({ type: "org.changed", orgId });
  assert.equal((await w.wsById(made.id)).org_missing_at, null);
  // P4: Ana, demoted to member in Mynt by a co-owner, isn't made owner again by reconciling.
  const bo = await w.person("Bo");
  await ana.call("invite_to_workspace", { workspace_id: made.id, email: bo.email, role: "owner" });
  await bo.call("accept_workspace_invite", { invite_id: (await bo.call("list_my_invitations")).invitations[0].id });
  await bo.call("change_member_role", { workspace_id: made.id, user_id: ana.user.id, role: "member" });
  await w.sync.reconcileAll();
  assert.equal(await w.role(made.id, ana.user.id), "member");
});

test("an organization the provider confirms deleted freezes its workspace (nobody removed, nobody new); an owner relinks it, or archives it (undoable for 7 days, or now)", async () => {
  const w = await setup();
  const ana = await w.person("Ana");
  const ben = await w.person("Ben");
  const made = await ana.call("create_workspace", { name: "Team" });
  const orgId = await w.orgOf(made.id);
  await ana.call("invite_to_workspace", { workspace_id: made.id, email: ben.email });
  await ben.call("accept_workspace_invite", { invite_id: (await ben.call("list_my_invitations")).invitations[0].id });
  w.dir.orgs.delete(orgId);
  w.dir.members.delete(orgId);
  await w.sync.handle({ type: "org.changed", orgId });
  assert.ok((await w.wsById(made.id)).org_missing_at);
  assert.equal(await w.role(made.id, ben.user.id), "member", "kept");
  assert.equal((await w.q("SELECT count(*)::int AS n FROM financial_products.workspace_offboards"))[0].n, 0);
  assert.match((await ana.call("invite_to_workspace", { workspace_id: made.id, email: "x@example.com" })).error, /frozen/);
  assert.ok((await ana.call("list_workspaces")).find((x) => x.id === made.id).org_missing_since);
  assert.match((await ben.call("relink_workspace_org", { workspace_id: made.id })).error, /owners/);
  // Relinked: a new organization with both in it.
  const r = await ana.call("relink_workspace_org", { workspace_id: made.id });
  assert.equal(r.relinked, true);
  const fresh = await w.orgOf(made.id);
  assert.notEqual(fresh, orgId);
  assert.equal(w.member(fresh, ben.subject), "member");
  assert.equal((await w.wsById(made.id)).org_missing_at, null);
  // Archived: undoable, then done at once.
  await ana.call("archive_workspace", { workspace_id: made.id });
  assert.equal(await w.role(made.id, ben.user.id), "member", "nobody removed yet");
  assert.equal((await ana.call("unarchive_workspace", { workspace_id: made.id })).archived, false);
  const now = await ana.call("archive_workspace", { workspace_id: made.id, now: true });
  assert.equal(now.done, true);
  assert.ok((await w.wsById(made.id)).archive_done_at);
  assert.equal(await w.role(made.id, ben.user.id), null);
  assert.equal((await w.q("SELECT count(*)::int AS n FROM financial_products.workspace_offboards WHERE workspace_id = $1", [made.id]))[0].n, 2);
  assert.ok(w.dir.called("deleteOrg", fresh));
});

// ---- the provider's removals and demotions ----

test("P6/P9: a removal confirmed by the provider offboards, and a late 'created' can't bring them back; an admin made a member there runs the demotion offboarding", async () => {
  const w = await setup();
  const ana = await w.person("Ana");
  const ben = await w.person("Ben");
  const made = await ana.call("create_workspace", { name: "T" });
  const orgId = await w.orgOf(made.id);
  await ana.call("invite_to_workspace", { workspace_id: made.id, email: ben.email, role: "admin" });
  await ben.call("accept_workspace_invite", { invite_id: (await ben.call("list_my_invitations")).invitations[0].id });
  assert.equal(w.member(orgId, ben.subject), "admin");
  // P9: made a member in the provider.
  w.dir.members.get(orgId).set(ben.subject, "member");
  await w.changed(orgId, ben.subject);
  assert.equal(await w.role(made.id, ben.user.id), "member");
  assert.equal((await w.q("SELECT count(*)::int AS n FROM financial_products.workspace_offboards WHERE user_id = $1 AND kind = 'demotion'", [ben.user.id]))[0].n, 1);
  // P6: removed there, then a late "created" event for him.
  w.dir.members.get(orgId).delete(ben.subject);
  await w.changed(orgId, ben.subject);
  assert.equal(await w.role(made.id, ben.user.id), null);
  assert.ok((await w.audits("workspace_offboard")).some((a) => a.details.user_id === ben.user.id));
  await w.changed(orgId, ben.subject);
  assert.equal(await w.role(made.id, ben.user.id), null);
});

test("someone a Mynt admin revoked is removed from the organization again, matched by any address the provider verified as theirs", async () => {
  const w = await setup();
  const ana = await w.person("Ana");
  const eve = await w.person("Eve");
  const made = await ana.call("create_workspace", { name: "T" });
  const orgId = await w.orgOf(made.id);
  w.dir.emails.set(eve.subject, [eve.email, "eve-alt@example.com"]);
  await w.store.blockSignup("eve-alt@example.com", null);
  w.dir.members.get(orgId).set(eve.subject, "member");
  await w.changed(orgId, eve.subject);
  assert.ok(w.dir.called("removeMember", orgId, eve.subject));
  assert.equal(await w.role(made.id, eve.user.id), null);
  assert.equal((await w.audits("workspace_member_refused")).length, 1);
});

// ---- Mynt to the provider ----

test("Mynt's changes go to the provider: accepting in Mynt, roles (an owner is its admin), removals, and every invite that stops standing", async () => {
  const w = await setup();
  const ana = await w.person("Ana");
  const ben = await w.person("Ben");
  const made = await ana.call("create_workspace", { name: "Team" });
  const orgId = await w.orgOf(made.id);
  await ana.call("invite_to_workspace", { workspace_id: made.id, email: ben.email, role: "admin" });
  const sent = w.dir.invitations[0];
  assert.deepEqual([sent.email, sent.role, sent.inviter], [ben.email, "admin", ana.subject]);
  const [mine] = (await ben.call("list_my_invitations")).invitations;
  assert.equal((await ben.call("accept_workspace_invite", { invite_id: mine.id })).workspace_id, made.id);
  assert.ok(w.dir.called("addMember", orgId, ben.subject, "admin"));
  assert.equal(sent.status, "revoked", "its invitation is spent");
  await ana.call("change_member_role", { workspace_id: made.id, user_id: ben.user.id, role: "member" });
  assert.equal(w.member(orgId, ben.subject), "member");
  await ana.call("change_member_role", { workspace_id: made.id, user_id: ben.user.id, role: "owner" });
  assert.equal(w.member(orgId, ben.subject), "admin");
  w.dir.fail.setMemberRole = true;
  assert.ok((await ana.call("change_member_role", { workspace_id: made.id, user_id: ben.user.id, role: "member" })).error);
  assert.equal(await w.role(made.id, ben.user.id), "owner", "the provider refused: nothing changed");
  w.dir.fail.setMemberRole = false;
  await ana.call("remove_workspace_member", { workspace_id: made.id, user_id: ben.user.id });
  assert.equal(w.member(orgId, ben.subject), null);
  // Withdrawn, declined, lapsed: the provider's invitation goes too.
  const cara = await ana.call("invite_to_workspace", { workspace_id: made.id, email: "cara@example.com" });
  await ana.call("revoke_workspace_invite", { invite_id: cara.id });
  assert.equal(w.dir.invitations[1].status, "revoked");
  const dan = await w.person("Dan");
  await ana.call("invite_to_workspace", { workspace_id: made.id, email: dan.email });
  await dan.call("decline_workspace_invite", { invite_id: (await dan.call("list_my_invitations")).invitations[0].id });
  assert.equal(w.dir.invitations[2].status, "revoked");
  const old = await ana.call("invite_to_workspace", { workspace_id: made.id, email: "old@example.com" });
  await w.q("UPDATE financial_products.workspace_invites SET created_at = now() - interval '31 days' WHERE id = $1", [old.id]);
  await releaseLapsedInvites(w.store);
  assert.equal(w.dir.invitations[3].status, "revoked");
  // Owners and admins see join requests; everyone the organization's own page.
  w.dir.members.get(orgId).set("user_newbie", "member");
  w.dir.emails.set("user_newbie", ["newbie@example.com"]);
  await w.changed(orgId, "user_newbie");
  const list = await ana.call("list_workspace_members", { workspace_id: made.id });
  assert.equal(list.manage_url, "https://accounts.example.test/organization");
  assert.deepEqual(list.join_requests.map((r) => r.email), ["newbie@example.com"]);
});

// ---- reconciling ----

test("reconciling fixes drift, each removal confirmed; someone in Mynt only is added to the provider, never taken out; new organizations are adopted at sign-in", async () => {
  const w = await setup();
  const ana = await w.person("Ana");
  const ben = await w.person("Ben");
  const cara = await w.person("Cara");
  const dan = await w.person("Dan");
  const made = await ana.call("create_workspace", { name: "Team" });
  const orgId = await w.orgOf(made.id);
  w.dir.members.get(orgId).set(ben.subject, "member"); // in the organization, not the workspace
  await w.q("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role, org_synced_at) VALUES ($1, $2, 'member', now())", [made.id, cara.user.id]); // seen there once, gone now
  await w.q("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [made.id, dan.user.id]); // Mynt only
  const r = await w.sync.reconcileAll();
  assert.equal(r.halted, undefined);
  assert.equal(await w.role(made.id, ben.user.id), "member");
  assert.equal(await w.role(made.id, cara.user.id), null);
  assert.equal(await w.role(made.id, dan.user.id), "member");
  assert.equal(w.member(orgId, dan.subject), "member", "added there");
  // At sign-in: an organization made in the provider by someone on Mynt.
  w.dir.providerOrg("org_cara", "Cara's", cara.subject);
  await w.sync.reconcileUser(cara.user.id, cara.subject, true);
  assert.equal(await w.role((await w.ws("org_cara")).id, cara.user.id), "owner");
});

test("P5/P5b: the circuit breaker: an empty listing, or taking out more than a tenth at once, changes nothing; a listing skipping one never freezes it", async () => {
  const w = await setup();
  const ana = await w.person("Ana");
  const a = await ana.call("create_workspace", { name: "A" });
  const b = await ana.call("create_workspace", { name: "B" });
  const c = await ana.call("create_workspace", { name: "C" });
  const list = w.dir.listOrgs;
  // P5: the provider lists nothing.
  w.dir.listOrgs = async () => ({ orgs: [], total: 0 });
  assert.match((await w.sync.reconcileAll()).halted, /listed no organizations/);
  assert.ok((await w.q("SELECT halted_at FROM financial_products.org_sync_status"))[0].halted_at);
  // P5b: a listing that skips one (offset paging while something changed): nothing frozen, it's confirmed one by one.
  w.dir.listOrgs = async (o, l) => {
    const r = await list(o, l);
    return { orgs: r.orgs.slice(1), total: r.total };
  };
  const ok = await w.sync.reconcileAll();
  assert.equal(ok.halted, undefined);
  for (const x of [a, b, c]) assert.equal((await w.wsById(x.id)).org_missing_at, null);
  assert.equal((await w.q("SELECT halted_at FROM financial_products.org_sync_status"))[0].halted_at, null, "a good run clears the stop");
  w.dir.listOrgs = list;
  // Two of three organizations gone at once: stop, change nothing.
  w.dir.orgs.delete(await w.orgOf(a.id));
  w.dir.orgs.delete(await w.orgOf(b.id));
  assert.match((await w.sync.reconcileAll()).halted, /2 of 3/);
  for (const x of [a, b]) assert.equal((await w.wsById(x.id)).org_missing_at, null);
  // Members: two of three seen members gone at once.
  w.dir.orgs.set(await w.orgOf(a.id), { id: await w.orgOf(a.id), name: "A", created_by: ana.subject, workspace_id: a.id });
  w.dir.orgs.set(await w.orgOf(b.id), { id: await w.orgOf(b.id), name: "B", created_by: ana.subject, workspace_id: b.id });
  const ben = await w.person("Ben");
  const cy = await w.person("Cy");
  for (const p of [ben, cy]) await w.q("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role, org_synced_at) VALUES ($1, $2, 'member', now())", [c.id, p.user.id]);
  assert.match((await w.sync.reconcileAll()).halted, /2 of \d+ workspace members/);
  assert.equal(await w.role(c.id, ben.user.id), "member");
});

// ---- backfill ----

test("backfill (P8/P8b): a dry run counts and changes nothing; --apply makes organizations and resumes after a failure; nobody is emailed without --send-invites; members not signed in are added later, never dropped", async () => {
  const w = await setup();
  setOrgDirectory(null); // workspaces made before organizations
  const ana = await w.person("Ana");
  const ben = await w.person("Ben");
  const lu = await w.person("Lu", ["developer"], { signedIn: false });
  const made = await ana.call("create_workspace", { name: "Old team" });
  await w.q("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')", [made.id, ben.user.id, lu.user.id]);
  await ana.call("invite_to_workspace", { workspace_id: made.id, email: "dan@example.com" });
  setOrgDirectory(w.dir);
  const dry = await w.sync.backfill(false);
  assert.deepEqual(dry, {
    workspaces_to_link: 1,
    orgs_created: 0,
    resumed: 0,
    members_added: 1,
    members_not_signed_in: 1,
    without_owner_signed_in: 0,
    invitation_emails_would_send: 1,
    invitation_emails_sent: 0,
    failed: 0,
  });
  assert.equal(w.dir.orgs.size, 0, "a dry run changes nothing");
  // P8b: the provider fails half-way.
  w.dir.fail.addMember = true;
  const half = await w.sync.backfill(true);
  assert.deepEqual([half.orgs_created, half.failed], [1, 1]);
  assert.equal((await w.wsById(made.id)).org_sync, "backfill");
  await w.sync.reconcileAll(); // leaves a workspace part-way alone
  assert.equal(await w.role(made.id, ben.user.id), "admin");
  w.dir.fail.addMember = false;
  const resumed = await w.sync.backfill(true);
  assert.deepEqual([resumed.resumed, resumed.members_added, resumed.invitation_emails_sent, resumed.invitation_emails_would_send], [1, 1, 0, 1]);
  const orgId = await w.orgOf(made.id);
  assert.equal(w.dir.orgs.get(orgId).workspace_id, made.id);
  assert.equal(w.member(orgId, ben.subject), "admin");
  assert.equal(w.dir.invitations.length, 0, "nobody emailed");
  // --send-invites: then the open invite becomes the provider's invitation.
  const sent = await w.sync.backfill(true, { sendInvites: true });
  assert.equal(sent.invitation_emails_sent, 1);
  assert.equal(w.dir.invitations[0].email, "dan@example.com");
  assert.ok(w.dir.invitations[0].metadata.mynt_invite_id);
  const again = await w.sync.backfill(true, { sendInvites: true });
  assert.deepEqual([again.workspaces_to_link, again.invitation_emails_sent], [0, 0], "idempotent");
  // P8: Lu signs in through the provider for the first time: added to the organization, still a member.
  await w.q("UPDATE financial_products.users SET clerk_user_id = 'user_lu' WHERE id = $1", [lu.user.id]);
  await w.sync.reconcileUser(lu.user.id, "user_lu", true);
  assert.equal(await w.role(made.id, lu.user.id), "member");
  assert.equal(w.member(orgId, "user_lu"), "member");
});

// ---- the Clerk adapter ----

test("the Clerk adapter waits out rate limits and takes only a 404 for 'gone'", async () => {
  const pk = `pk_test_${Buffer.from("example.clerk.accounts.dev$").toString("base64")}`;
  const replies = [];
  const fetchFn = async (url) => {
    const [status, body] = replies.shift();
    return new Response(JSON.stringify(body), { status, headers: { "retry-after": "1" } });
  };
  const slept = [];
  const clerk = new ClerkOrgDirectory({ secretKey: "test-key", publishableKey: pk }, fetchFn, async (ms) => void slept.push(ms));
  replies.push([429, {}], [429, {}], [200, { id: "org_1", name: "A", created_by: "user_1", private_metadata: { mynt_workspace_id: "ws_1" } }]);
  assert.deepEqual(await clerk.createOrg("A", "user_1", "ws_1"), { id: "org_1", name: "A", created_by: "user_1", workspace_id: "ws_1" });
  assert.deepEqual(slept, [1000, 1000]);
  replies.push([404, { errors: [{ message: "not found" }] }]);
  assert.equal(await clerk.getOrg("org_x"), null);
  replies.push([500, { errors: [{ message: "down" }] }]);
  await assert.rejects(clerk.getOrg("org_x"), /down/);
});
