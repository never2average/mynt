import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { createMcpHttpServer } from "../dist/http.js";
import { Store } from "../dist/store.js";
import { setOrgDirectory } from "../dist/workspaces.js";
import { WorkspaceSync } from "../dist/workspace-sync.js";
import { CATALOG } from "./helpers.js";

// The identity provider's organizations, in memory: what Mynt asks of it is recorded, and a test can make any call fail.
function fakeDirectory() {
  const d = {
    orgs: new Map(), // id -> { id, name, created_by }
    members: new Map(), // org id -> Map(subject -> { role, email })
    invitations: [],
    calls: [],
    fail: {},
    nextId: null,
    log(name, ...a) {
      d.calls.push([name, ...a]);
      if (d.fail[name]) throw new Error(`${name} failed`);
    },
    async createOrg(name, createdBy) {
      d.log("createOrg", name, createdBy);
      const id = d.nextId ?? `org_${d.orgs.size + 1}_${randomUUID().slice(0, 4)}`;
      d.nextId = null;
      d.orgs.set(id, { id, name, created_by: createdBy });
      d.members.set(id, new Map([[createdBy, { role: "admin", email: null }]]));
      return { id, name, created_by: createdBy };
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
      return [...(d.members.get(id) ?? new Map())].map(([subject, m]) => ({ subject, role: m.role, email: m.email }));
    },
    async userMemberships(subject) {
      return [...d.members].filter(([, ms]) => ms.has(subject)).map(([id, ms]) => ({ org: d.orgs.get(id), role: ms.get(subject).role }));
    },
    async addMember(id, subject, role) {
      d.log("addMember", id, subject, role);
      d.members.get(id).set(subject, { role, email: null });
    },
    async setMemberRole(id, subject, role) {
      d.log("setMemberRole", id, subject, role);
      d.members.get(id).get(subject).role = role;
    },
    async removeMember(id, subject) {
      d.log("removeMember", id, subject);
      d.members.get(id)?.delete(subject);
    },
    async invite(id, o) {
      d.log("invite", id, o);
      const inv = { id: `inv_${d.invitations.length + 1}`, org: id, ...o };
      d.invitations.push(inv);
      return { id: inv.id };
    },
    async revokeInvitation(id, invitationId) {
      d.log("revokeInvitation", id, invitationId);
    },
    manageUrl: () => "https://accounts.example.test/organization",
  };
  return d;
}

// Signed as the Standard Webhooks spec says (what Clerk's webhooks use), independently of the library Mynt verifies with.
const sign = (secret, id, at, body) => `v1,${createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64")).update(`${id}.${Math.floor(at.getTime() / 1000)}.${body}`).digest("base64")}`;
const SECRET = `whsec_${Buffer.from("a-test-signing-secret-of-32-bytes!").toString("base64")}`;

async function setup() {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const dir = fakeDirectory();
  setOrgDirectory(dir);
  const sync = new WorkspaceSync(store, dir);
  const person = async (name, roles = ["developer"]) => {
    const { user } = await store.createUser(name, roles);
    const email = `${name.toLowerCase()}@example.com`;
    const subject = `user_${name.toLowerCase()}`;
    await pg.query("UPDATE financial_products.users SET email = $2, clerk_user_id = $3 WHERE id = $1", [user.id, email, subject]);
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
  const role = async (wsId, userId) => (await pg.query("SELECT role FROM financial_products.workspace_members WHERE workspace_id = $1 AND user_id = $2", [wsId, userId])).rows[0]?.role ?? null;
  const ws = async (orgId) => (await pg.query("SELECT id::text AS id, name, archived_at FROM financial_products.workspaces WHERE external_org_id = $1", [orgId])).rows[0];
  const audits = async (action) => (await pg.query("SELECT target, details FROM financial_products.audit_log WHERE action = $1", [action])).rows;
  return { pg, store, dir, sync, person, role, ws, audits };
}

afterEach(() => setOrgDirectory(null));

test("creating a workspace creates its organization (the creator its owner); if the workspace can't be made, the organization goes again", async () => {
  const w = await setup();
  const ana = await w.person("Ana");
  const made = await ana.call("create_workspace", { name: "Team" });
  const [, , createdBy] = w.dir.calls.find((c) => c[0] === "createOrg");
  assert.equal(createdBy, ana.subject);
  const orgId = [...w.dir.orgs.keys()][0];
  assert.equal((await w.ws(orgId)).id, made.id);
  assert.equal(await w.role(made.id, ana.user.id), "owner");
  // The provider refuses: no workspace.
  w.dir.fail.createOrg = true;
  assert.match((await ana.call("create_workspace", { name: "Nope" })).error ?? "", /failed/);
  assert.equal((await w.pg.query("SELECT count(*)::int AS n FROM financial_products.workspaces WHERE name = 'Nope'")).rows[0].n, 0);
  w.dir.fail.createOrg = false;
  // The organization is made but the workspace can't be (here: that organization is already a workspace's): it's deleted.
  w.dir.nextId = orgId;
  assert.ok((await ana.call("create_workspace", { name: "Twin" })).error);
  assert.ok(w.dir.calls.some((c) => c[0] === "deleteOrg" && c[1] === orgId));
});

test("the webhook: a valid signature is applied once; a bad or stale one is refused", async () => {
  const w = await setup();
  process.env.CLERK_WEBHOOK_SECRET = SECRET;
  const http = createMcpHttpServer(w.store, null, { workspaceSync: w.sync }).listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const base = `http://127.0.0.1:${http.address().port}`;
  const send = async (event, { id = `msg_${randomUUID()}`, at = new Date(), secret = SECRET } = {}) => {
    const body = JSON.stringify(event);
    const sig = sign(secret, id, at, body);
    const res = await fetch(`${base}/webhooks/clerk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "svix-id": id, "svix-timestamp": String(Math.floor(at.getTime() / 1000)), "svix-signature": sig },
      body,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  try {
    const created = { type: "organization.created", data: { id: "org_hook", name: "From the dashboard", created_by: null } };
    const id = "msg_once";
    assert.equal((await send(created, { id })).status, 200);
    assert.ok(await w.ws("org_hook"));
    assert.deepEqual((await send(created, { id })).body, { duplicate: true }, "the same event again: handled once");
    assert.equal((await send(created, { secret: `whsec_${Buffer.from("not-the-secret-not-the-secret-xx").toString("base64")}` })).status, 400);
    assert.equal((await send(created, { at: new Date(Date.now() - 60 * 60_000) })).status, 400, "an old (replayed) signature");
    const unsigned = await fetch(`${base}/webhooks/clerk`, { method: "POST", body: JSON.stringify(created) });
    assert.equal(unsigned.status, 400);
    // Off without a secret.
    delete process.env.CLERK_WEBHOOK_SECRET;
    assert.equal((await send(created)).status, 404);
  } finally {
    delete process.env.CLERK_WEBHOOK_SECRET;
    http.closeAllConnections();
    http.close();
  }
});

test("each event: organizations and memberships follow the provider, owners stay Mynt's, the creator owns, a deleted membership offboards", async () => {
  const w = await setup();
  const ana = await w.person("Ana");
  const ben = await w.person("Ben");
  const org = { id: "org_x", name: "X", created_by: ana.subject };
  await w.sync.handle({ type: "org.upserted", org });
  const x = await w.ws("org_x");
  assert.equal(await w.role(x.id, ana.user.id), "owner", "the creator owns it");
  await w.sync.handle({ type: "membership.upserted", org, member: { subject: ben.subject, role: "admin", email: ben.email } });
  assert.equal(await w.role(x.id, ben.user.id), "admin");
  await w.sync.handle({ type: "membership.upserted", org, member: { subject: ben.subject, role: "member", email: ben.email } });
  assert.equal(await w.role(x.id, ben.user.id), "member");
  // The provider calls the creator an admin: still Mynt's owner.
  await w.sync.handle({ type: "membership.upserted", org, member: { subject: ana.subject, role: "admin", email: ana.email } });
  assert.equal(await w.role(x.id, ana.user.id), "owner");
  await w.sync.handle({ type: "org.upserted", org: { ...org, name: "X renamed" } });
  assert.equal((await w.ws("org_x")).name, "X renamed");
  // A membership deleted: out, with Mynt's offboarding.
  await w.sync.handle({ type: "membership.deleted", orgId: "org_x", subject: ben.subject });
  assert.equal(await w.role(x.id, ben.user.id), null);
  assert.ok((await w.audits("workspace_offboard")).some((a) => a.details.user_id === ben.user.id));
  // The organization deleted: the workspace archived, everyone offboarded.
  await w.sync.handle({ type: "org.deleted", orgId: "org_x" });
  assert.ok((await w.ws("org_x")).archived_at);
  assert.equal(await w.role(x.id, ana.user.id), null);
});

test("newcomers join Mynt as a developer, or a user when the invitation said so, never more; someone an admin revoked is removed again", async () => {
  const w = await setup();
  const ana = await w.person("Ana");
  const ws = await ana.call("create_workspace", { name: "Team" });
  const orgId = [...w.dir.orgs.keys()][0];
  const org = w.dir.orgs.get(orgId);
  // Unknown to Mynt, joined in the provider: let in as a developer.
  await w.sync.handle({ type: "membership.upserted", org, member: { subject: "user_new", role: "admin", email: "new@example.com" } });
  assert.deepEqual((await w.store.getInvite("new@example.com")).roles, ["developer"]);
  // Invited from Mynt as a user: a user (consumer) only.
  await ana.call("invite_to_workspace", { workspace_id: ws.id, email: "uma@example.com", mynt_role: "user" });
  await w.pg.query("DELETE FROM financial_products.invites WHERE email = 'uma@example.com'");
  await w.sync.handle({ type: "membership.upserted", org, member: { subject: "user_uma", role: "member", email: "uma@example.com" } });
  assert.deepEqual((await w.store.getInvite("uma@example.com")).roles, ["consumer"]);
  // Invited in the provider's own dashboard as a user: the invitation's metadata says so.
  await w.sync.handle({ type: "membership.upserted", org, member: { subject: "user_val", role: "member", email: "val@example.com" } });
  await w.sync.handle({ type: "invitation.accepted", orgId, email: "val@example.com", metadata: { mynt_role: "user" } });
  assert.deepEqual((await w.store.getInvite("val@example.com")).roles, ["consumer"]);
  const granted = (await w.pg.query("SELECT roles FROM financial_products.invites")).rows.flatMap((r) => r.roles);
  assert.ok(!granted.includes("admin"));
  // Revoked by a Mynt admin: removed from the organization again.
  await w.store.blockSignup("eve@example.com", null);
  await w.sync.handle({ type: "membership.upserted", org, member: { subject: "user_eve", role: "member", email: "eve@example.com" } });
  assert.ok(w.dir.calls.some((c) => c[0] === "removeMember" && c[2] === "user_eve"));
  assert.equal((await w.audits("workspace_member_refused")).length, 1);
  assert.equal(await w.store.getInvite("eve@example.com"), undefined);
});

test("Mynt's changes go to the provider: invitations, roles (an owner is its admin), removals, and joining in Mynt", async () => {
  const w = await setup();
  const ana = await w.person("Ana");
  const ben = await w.person("Ben");
  const ws = await ana.call("create_workspace", { name: "Team" });
  const orgId = [...w.dir.orgs.keys()][0];
  const inv = await ana.call("invite_to_workspace", { workspace_id: ws.id, email: ben.email, role: "admin" });
  const sent = w.dir.invitations[0];
  assert.deepEqual([sent.email, sent.role, sent.inviter, sent.metadata.mynt_role, sent.metadata.mynt_workspace_role], [ben.email, "admin", ana.subject, "developer", "admin"]);
  // Ben accepts in Mynt: he joins the organization too, and its invitation is spent.
  const [mine] = (await ben.call("list_my_invitations")).invitations;
  assert.equal((await ben.call("accept_workspace_invite", { invite_id: mine.id })).workspace_id, ws.id);
  assert.ok(w.dir.calls.some((c) => c[0] === "addMember" && c[1] === orgId && c[2] === ben.subject && c[3] === "admin"));
  assert.ok(w.dir.calls.some((c) => c[0] === "revokeInvitation" && c[2] === sent.id));
  // Roles: owner and admin are the provider's admin, member its member.
  await ana.call("change_member_role", { workspace_id: ws.id, user_id: ben.user.id, role: "member" });
  assert.equal(w.dir.members.get(orgId).get(ben.subject).role, "member");
  await ana.call("change_member_role", { workspace_id: ws.id, user_id: ben.user.id, role: "owner" });
  assert.equal(w.dir.members.get(orgId).get(ben.subject).role, "admin");
  // If the provider refuses, nothing changes in Mynt.
  w.dir.fail.setMemberRole = true;
  assert.ok((await ana.call("change_member_role", { workspace_id: ws.id, user_id: ben.user.id, role: "member" })).error);
  assert.equal(await w.role(ws.id, ben.user.id), "owner");
  w.dir.fail.setMemberRole = false;
  await ana.call("remove_workspace_member", { workspace_id: ws.id, user_id: ben.user.id });
  assert.equal(w.dir.members.get(orgId).has(ben.subject), false);
  // Withdrawing an invitation withdraws the provider's too.
  const cara = await ana.call("invite_to_workspace", { workspace_id: ws.id, email: "cara@example.com" });
  await ana.call("revoke_workspace_invite", { invite_id: cara.id });
  assert.ok(w.dir.calls.some((c) => c[0] === "revokeInvitation" && c[2] === w.dir.invitations[1].id));
  // Members can open the organization's own page.
  assert.equal((await ana.call("list_workspace_members", { workspace_id: ws.id })).manage_url, "https://accounts.example.test/organization");
  void inv;
});

test("reconciling fixes drift: missing members added, extra ones offboarded, an organization gone archives its workspace; at sign-in too", async () => {
  const w = await setup();
  const ana = await w.person("Ana");
  const ben = await w.person("Ben");
  const cara = await w.person("Cara");
  const ws = await ana.call("create_workspace", { name: "Team" });
  const orgId = [...w.dir.orgs.keys()][0];
  // Drift: Ben is in the organization but not the workspace; Cara the other way round.
  w.dir.members.get(orgId).set(ben.subject, { role: "member", email: ben.email });
  await w.pg.query("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [ws.id, cara.user.id]);
  // A workspace whose organization is gone.
  const gone = await ana.call("create_workspace", { name: "Gone" });
  const goneOrg = [...w.dir.orgs.keys()][1];
  w.dir.orgs.delete(goneOrg);
  const r = await w.sync.reconcileAll();
  assert.ok(r.fixed >= 2);
  assert.equal(await w.role(ws.id, ben.user.id), "member");
  assert.equal(await w.role(ws.id, cara.user.id), null);
  assert.ok((await w.pg.query("SELECT archived_at FROM financial_products.workspaces WHERE id = $1", [gone.id])).rows[0].archived_at);
  // At sign-in: one person's memberships.
  const another = await w.dir.createOrg("Another", "user_someone");
  w.dir.members.get(another.id).set(cara.subject, { role: "admin", email: cara.email });
  await w.sync.reconcileUser(cara.user.id, cara.subject, true);
  assert.equal(await w.role((await w.ws(another.id)).id, cara.user.id), "admin");
});

test("backfill: a dry run counts; --apply gives each old workspace an organization with its members and open invites; running it again does nothing", async () => {
  const w = await setup();
  setOrgDirectory(null); // workspaces made before organizations
  const ana = await w.person("Ana");
  const ben = await w.person("Ben");
  const ws = await ana.call("create_workspace", { name: "Old team" });
  await w.pg.query("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')", [ws.id, ben.user.id]);
  await ana.call("invite_to_workspace", { workspace_id: ws.id, email: "dan@example.com" });
  setOrgDirectory(w.dir);
  const dry = await w.sync.backfill(false);
  assert.deepEqual(dry, { workspaces_without_org: 1, orgs_created: 0, members_added: 1, members_not_signed_in: 0, without_owner_signed_in: 0, invites_converted: 1 });
  assert.equal(w.dir.orgs.size, 0, "a dry run changes nothing");
  const done = await w.sync.backfill(true);
  assert.deepEqual([done.orgs_created, done.members_added, done.invites_converted], [1, 1, 1]);
  const orgId = [...w.dir.orgs.keys()][0];
  assert.equal(w.dir.orgs.get(orgId).created_by, ana.subject);
  assert.equal(w.dir.members.get(orgId).get(ben.subject).role, "admin");
  assert.equal(w.dir.invitations[0].email, "dan@example.com");
  assert.equal((await w.sync.backfill(true)).workspaces_without_org, 0, "idempotent");
  assert.equal(w.dir.orgs.size, 1);
});
