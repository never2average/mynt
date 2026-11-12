import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RepoAccess } from "./github.js";
import type { Store } from "./store.js";

// Stopgap until people prove they can push to a repository themselves (the git-account check): an admin approves
// each repository connection before Mynt gives out any token for it. The repository host's app being installed on a
// repository only says Mynt can reach it, not that the person asking may use it.
//
// A developer's connection (developer and repository) and a firm's desk workspace (firm and repository) each start
// `pending_approval`; an admin approves or rejects it, seeing who asked, their firm, and which account the app's
// installation belongs to. Approval is per connection, never per repository: another developer's connection to the
// same repository needs its own. Mynt's own managed repositories (each app's, src/git-host.ts) are approved as Mynt
// creates them. Connections that existed before this check start pending too.

export const PENDING = "pending_approval";
export const APPROVED = "approved";
export const REJECTED = "rejected";

const T = "financial_products";

// The approval columns, for repo_connections and desk_workspaces (each created by its own service). A row that existed
// before these columns gets `pending_approval`: it fails closed.
export const approvalColumns = (table: string) => `
  ALTER TABLE ${T}.${table} ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
  ALTER TABLE ${T}.${table} ADD COLUMN IF NOT EXISTS approval text NOT NULL DEFAULT '${PENDING}';
  ALTER TABLE ${T}.${table} ADD COLUMN IF NOT EXISTS approval_note text;
  ALTER TABLE ${T}.${table} ADD COLUMN IF NOT EXISTS decided_by uuid;
  ALTER TABLE ${T}.${table} ADD COLUMN IF NOT EXISTS decided_at timestamptz;
`;

// For an upsert's ON CONFLICT (whose SET reads the row's old values): an approved connection stays approved only when
// the same repository is connected again through the same installation; anything else (a new repository or
// installation, or one rejected or still pending) is a new request. Approvals don't expire (this is a stopgap).
export const reapprovalOnConflict = (table: string, sameRepository = "TRUE") => {
  const same = `${table}.approval = '${APPROVED}' AND ${sameRepository} AND ${table}.installation_id = EXCLUDED.installation_id`;
  return `approval = CASE WHEN ${same} THEN '${APPROVED}' ELSE '${PENDING}' END,
   approval_note = CASE WHEN ${same} THEN ${table}.approval_note END,
   decided_by = CASE WHEN ${same} THEN ${table}.decided_by END,
   decided_at = CASE WHEN ${same} THEN ${table}.decided_at END`;
};

// Throws, saying why, unless the connection is approved.
export function requireApproved(approval: string | null | undefined, repository: string) {
  if (approval === APPROVED) return;
  if (approval === REJECTED) throw new Error(`An admin rejected access to ${repository}; connect a repository of your own, or ask an admin`);
  throw new Error(`Waiting for an admin to approve access to ${repository}`);
}

export async function connectionApproval(db: Store["db"], developerId: string, repository: string) {
  const r = (await db.query(`SELECT approval FROM ${T}.repo_connections WHERE developer_id = $1 AND repository = $2`, [developerId, repository.toLowerCase()])).rows[0] as
    | { approval: string }
    | undefined;
  return r?.approval ?? null;
}

const NOTICES = `
  CREATE TABLE IF NOT EXISTS ${T}.repository_access_notices (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES ${T}.users(id),
    repository text NOT NULL,
    decision text NOT NULL,
    note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at timestamptz
  );
`;

type Row = Record<string, unknown>;

// A Mynt without builds (or without the desk) has no such table: nothing to list there. Any other error is raised.
const noTable = (e: { code?: string }) => {
  if (e?.code === "42P01") return { rows: [] };
  throw e;
};

// Every connection waiting for (or past) a decision, from both tables, with what an admin needs to judge it.
async function requests(store: Store, repos: RepoAccess | null, status: string | null) {
  const devs = (await store.db
    .query(
      `SELECT c.id, 'developer' AS kind, c.repository, c.installation_id, c.approval, c.approval_note, c.created_at, u.id AS user_id, u.name, e.name AS firm
       FROM ${T}.repo_connections c JOIN ${T}.users u ON u.id = c.developer_id LEFT JOIN ${T}.entities e ON e.id = u.entity_id
       WHERE ($1::text IS NULL OR c.approval = $1)`,
      [status],
    )
    .catch(noTable)).rows as Row[];
  const desks = (await store.db
    .query(
      `SELECT w.id, 'desk_workspace' AS kind, w.repository, w.installation_id, w.approval, w.approval_note, w.created_at, u.id AS user_id, u.name, e.name AS firm
       FROM ${T}.desk_workspaces w JOIN ${T}.entities e ON e.id = w.entity_id LEFT JOIN ${T}.users u ON u.id = w.connected_by
       WHERE ($1::text IS NULL OR w.approval = $1)`,
      [status],
    )
    .catch(noTable)).rows as Row[];
  const out = [];
  for (const r of [...devs, ...desks]) {
    const account = repos?.installationAccount ? await repos.installationAccount(Number(r.installation_id)).catch(() => null) : null;
    out.push({
      id: String(r.id),
      kind: r.kind as string,
      repository: r.repository as string,
      status: r.approval as string,
      note: (r.approval_note as string | null) ?? null,
      installation_id: Number(r.installation_id), // with repository, what approve and reject must name
      requested_by: { user_id: (r.user_id as string | null) ?? null, name: (r.name as string | null) ?? null, firm: (r.firm as string | null) ?? null },
      installation_account: account, // whose account the app's installation is on: { login, type }
      requested_at: new Date(String(r.created_at)).toISOString(),
    });
  }
  return out.sort((a, b) => a.requested_at.localeCompare(b.requested_at));
}

// Applies only to exactly the request the admin saw: the same row, repository and installation. A connection changed
// since (a firm reconnecting its workspace to another repository keeps its row) isn't touched. Approving needs it
// pending; rejecting also withdraws an approval.
async function decide(store: Store, adminId: string, id: string, repository: string, installationId: number, decision: typeof APPROVED | typeof REJECTED, note: string) {
  const from = decision === APPROVED ? [PENDING] : [PENDING, APPROVED];
  for (const [table, who] of [
    ["repo_connections", "developer_id"],
    ["desk_workspaces", "connected_by"],
  ] as const) {
    const r = (await store.db
      .query(
        `UPDATE ${T}.${table} SET approval = $2, approval_note = $3, decided_by = $4, decided_at = now()
         WHERE id::text = $1 AND repository = $5 AND installation_id = $6 AND approval = ANY($7) RETURNING repository, ${who} AS user_id`,
        [id, decision, note, adminId, repository.toLowerCase(), installationId, from],
      )
      .catch(noTable)).rows[0] as Row | undefined;
    if (!r) continue;
    const kind = table === "repo_connections" ? "developer" : "desk_workspace";
    await store.db.exec(NOTICES);
    await store.audit(adminId, decision === APPROVED ? "approve_repository_connection" : "reject_repository_connection", id, { kind, repository: r.repository, user_id: r.user_id, note });
    if (r.user_id)
      await store.db.query(`INSERT INTO ${T}.repository_access_notices (id, user_id, repository, decision, note) VALUES ($1, $2, $3, $4, $5)`, [
        randomUUID(),
        r.user_id,
        r.repository,
        decision,
        note,
      ]);
    return { id, kind, repository: r.repository as string, status: decision };
  }
  throw new Error(`No ${decision === APPROVED ? "pending " : ""}connection '${id}' to ${repository} through installation ${installationId}: it may have changed since it was listed; list again`);
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

// Admins decide; every decision is audited and told to the person who asked.
export function registerRepoApprovalAdminTools(server: McpServer, store: Store, adminId: string, repos: RepoAccess | null) {
  server.registerTool(
    "list_repository_requests",
    {
      title: "Repository connections to approve",
      description:
        "Admin: developers' repository connections and firms' desk workspaces, pending approval by default (status to see others). Each shows who asked, their firm, the repository and the account the app's installation is on (login and type), to judge whether they own it. Mynt gives out no token for a connection until it's approved.",
      inputSchema: { status: z.enum([PENDING, APPROVED, REJECTED]).optional().default(PENDING) },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => json(await requests(store, repos, status)),
  );
  for (const [name, decision, field, title] of [
    ["approve_repository_connection", APPROVED, "note", "Approve a repository connection"],
    ["reject_repository_connection", REJECTED, "reason", "Reject a repository connection"],
  ] as const) {
    server.registerTool(
      name,
      {
        title,
        description: `Admin: ${decision === APPROVED ? "let" : "stop"} Mynt ${decision === APPROVED ? "give out" : "giving out"} tokens for this connection. Name it exactly as list_repository_requests showed it (id, repository, installation_id): if it changed since, nothing is ${decision === APPROVED ? "approved" : "rejected"}. Audited; the person who asked is told.`,
        inputSchema: { id: z.string().uuid(), repository: z.string().min(3).max(200), installation_id: z.number().int().positive(), [field]: z.string().min(3).max(500) },
        annotations: decision === REJECTED ? { destructiveHint: true } : {},
      },
      async (args: Record<string, string | number>) => {
        try {
          return json(await decide(store, adminId, String(args.id), String(args.repository), Number(args.installation_id), decision, String(args[field])));
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    );
  }
}

// The person who asked: decisions on their connections.
export function registerRepoAccessNoticeTools(server: McpServer, store: Store, userId: string) {
  server.registerTool(
    "repository_access_notices",
    {
      title: "Decisions on your repository access",
      description: "Admins' decisions on the repositories you connected (for builds or your firm's desk workspace): approved or rejected, with their note.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      await store.db.exec(NOTICES);
      const { rows } = await store.db.query(
        `SELECT repository, decision, note, created_at FROM ${T}.repository_access_notices WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [userId],
      );
      await store.db.query(`UPDATE ${T}.repository_access_notices SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [userId]);
      return json((rows as Row[]).map((r) => ({ repository: r.repository, decision: r.decision, note: r.note, at: new Date(String(r.created_at)).toISOString() })));
    },
  );
}
