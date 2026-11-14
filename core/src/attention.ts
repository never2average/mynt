import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "./db.js";
import { effectiveStages, stageChecks, staleSignoff } from "./promotions.js";
import { PENDING } from "./repo-approvals.js";
import type { Store, User } from "./store.js";
import { workspaceLicences } from "./workspace-compliance.js";
import { workspaceRole, type WorkspaceRole } from "./workspaces.js";

// What needs someone's attention in one workspace, for the caller's role in it: the studio's attention list. Only the
// workspace's members ask, and only about that workspace: its apps, its licences, its own members' offboarding.
// Everyone sees the workspace frozen (its organization deleted in the identity provider) or being archived, failed
// and blocked builds, production apps whose checks now fail, licences expiring within 30 days, and their own
// repository connections waiting for an admin. Owners and admins also see join requests (people not on Mynt who
// joined its organization), offboarding that didn't finish, webhooks whose receivers need a new secret (or that were
// turned off), and sign-offs: asked, decided, or approved but no longer counting. Nobody in a workspace decides its
// sign-offs, so none is ever shown as waiting for the caller.

export type Severity = "high" | "medium" | "low";
export interface AttentionItem {
  id: string;
  kind: string;
  severity: Severity;
  title: string;
  detail: string;
  href: string;
  at: string;
}

const T = "financial_products";
type Row = Record<string, unknown>;
const DAY = 24 * 3600 * 1000;
const RECENT_DAYS = 14;
const LICENCE_DAYS = 30;
const iso = (v: unknown) => new Date(v as string).toISOString();
const rowsOf = async (db: Db, sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Row[];
const short = (id: unknown) => String(id ?? "").slice(0, 8);

async function tables(db: Db, names: string[]): Promise<Set<string>> {
  const r = await rowsOf(db, `SELECT n FROM unnest($1::text[]) AS n WHERE to_regclass('${T}.' || n) IS NOT NULL`, [names]);
  return new Set(r.map((x) => x.n as string));
}

export async function workspaceAttention(store: Store, user: Pick<User, "id">, workspaceId: string, o: { role: WorkspaceRole }) {
  const db = store.db;
  const manager = o.role !== "member";
  const have = await tables(db, ["build_runs", "repo_connections", "app_repositories"]);
  const apps = await store.appsVisibleTo(user.id, workspaceId);
  const ids = apps.map((a) => a.id);
  const name = new Map(apps.map((a) => [a.id, a.name]));
  const items: AttentionItem[] = [];
  const now = Date.now();

  // The workspace itself: frozen, or being archived (everyone is removed when the window ends).
  const ws = (await rowsOf(db, `SELECT org_missing_at, archived_at, archive_offboard_at, archive_done_at FROM ${T}.workspaces WHERE id::text = $1`, [workspaceId]))[0];
  if (ws?.archived_at && !ws.archive_done_at)
    items.push({
      id: `workspace_archiving:${workspaceId}`,
      kind: "workspace_archiving",
      severity: "high",
      title: "This workspace is being archived",
      detail: `Everyone is removed and offboarded${ws.archive_offboard_at ? ` on ${iso(ws.archive_offboard_at).slice(0, 10)}` : ""}; until then an owner can undo it (unarchive_workspace). No app changes stage meanwhile`,
      href: "/workspace?tab=members",
      at: iso(ws.archived_at),
    });
  else if (ws?.org_missing_at)
    items.push({
      id: `workspace_frozen:${workspaceId}`,
      kind: "workspace_frozen",
      severity: "high",
      title: "This workspace is frozen",
      detail: "Its organization was deleted in the identity provider: nobody new joins and no app changes stage until an owner relinks it (relink_workspace_org) or archives it (archive_workspace)",
      href: "/workspace?tab=members",
      at: iso(ws.org_missing_at),
    });

  // People not on Mynt who joined the workspace's organization: an owner or admin invites them to let them in.
  if (manager)
    for (const j of await rowsOf(db, `SELECT subject, email, created_at FROM ${T}.workspace_join_requests WHERE workspace_id::text = $1 ORDER BY created_at DESC`, [workspaceId]))
      items.push({
        id: `join_request:${j.subject}`,
        kind: "join_request",
        severity: "medium",
        title: `${j.email ?? "Someone"} joined the workspace's organization but isn't on Mynt`,
        detail: "Invite them (invite_to_workspace) to let them in; until then they have no access",
        href: "/workspace?tab=members",
        at: iso(j.created_at),
      });

  // Builds whose latest end was a failure, unless a later build of the app succeeded.
  if (have.has("build_runs") && ids.length) {
    const ended = await rowsOf(
      db,
      `SELECT DISTINCT ON (app_id) id::text AS id, app_id::text AS app_id, status, error, COALESCE(finished_at, updated_at) AS at
       FROM ${T}.build_runs WHERE app_id::text = ANY($1) AND status IN ('succeeded', 'blocked', 'failed', 'over_budget')
         AND COALESCE(finished_at, updated_at) > now() - make_interval(days => $2)
       ORDER BY app_id, COALESCE(finished_at, updated_at) DESC`,
      [ids, RECENT_DAYS],
    );
    for (const b of ended) {
      if (b.status === "succeeded") continue;
      const app = b.app_id as string;
      const blocked = b.status === "blocked";
      items.push({
        id: `build_${b.status}:${b.id}`,
        kind: blocked ? "build_blocked" : "build_failed",
        severity: blocked ? "high" : "medium",
        title: `${name.get(app)}: build ${short(b.id)} ${blocked ? "was blocked" : b.status === "over_budget" ? "ran over budget" : "failed"}`,
        detail: String(b.error ?? (blocked ? "Blocked" : "Failed")).slice(0, 500),
        href: `/${app}`,
        at: iso(b.at),
      });
    }
  }

  // The caller's own repository connections for the workspace's apps, waiting for an admin.
  if (have.has("repo_connections") && ids.length) {
    const repoOf = [
      ...(have.has("app_repositories") ? [`SELECT app_id::text AS app_id, lower(repository) AS repository FROM ${T}.app_repositories WHERE app_id::text = ANY($1)`] : []),
      ...(have.has("build_runs") ? [`SELECT app_id::text AS app_id, lower(repository) AS repository FROM ${T}.build_runs WHERE app_id::text = ANY($1) AND repository IS NOT NULL`] : []),
    ];
    if (repoOf.length) {
      const pending = await rowsOf(
        db,
        `SELECT DISTINCT ON (c.repository) c.repository, r.app_id, c.created_at FROM ${T}.repo_connections c JOIN (${repoOf.join(" UNION ")}) r ON r.repository = lower(c.repository)
         WHERE c.developer_id = $2 AND c.approval = $3 ORDER BY c.repository, r.app_id`,
        [ids, user.id, PENDING],
      );
      for (const p of pending)
        items.push({
          id: `repo_approval:${p.repository}`,
          kind: "repository_approval_pending",
          severity: "medium",
          title: `${name.get(p.app_id as string)}: access to ${p.repository} waits for a Mynt admin`,
          detail: "Builds that push to it wait until an admin approves your connection",
          href: `/${p.app_id}`,
          at: iso(p.created_at),
        });
    }
  }

  // Production apps whose production checks fail now.
  const stages = await effectiveStages(db, apps);
  for (const app of apps) {
    if (stages.get(app.id) !== "production") continue;
    const r = await stageChecks(db, store, app, "production", "production");
    const failing = r.checks.filter((c) => c.status === "fail");
    if (!failing.length) continue;
    items.push({
      id: `promotion_failing:${app.id}`,
      kind: "promotion_checks_failing",
      severity: "high",
      title: `${app.name}: ${failing.length} production check(s) failing`,
      detail: failing.map((c) => `${c.label}: ${c.detail}`).join("; ").slice(0, 1000),
      href: `/${app.id}`,
      at: new Date(now).toISOString(),
    });
  }

  // Sign-offs, for owners and admins: asked and waiting for a Mynt admin (one outside the workspace decides), decided
  // lately, or approved but no longer counting (its programs or money rails changed without a new build). Never shown
  // as waiting for the caller: nobody in the workspace decides its sign-offs.
  if (ids.length && manager) {
    const signoffs = await rowsOf(
      db,
      `SELECT id::text AS id, app_id::text AS app_id, build_id::text AS build_id, status, note, requested_at, decided_at FROM ${T}.promotion_signoffs
       WHERE app_id::text = ANY($1) AND (status = 'requested' OR (status IN ('approved', 'rejected') AND decided_at > now() - make_interval(days => $2)))
       ORDER BY requested_at DESC`,
      [ids, RECENT_DAYS],
    );
    for (const s of signoffs) {
      const app = s.app_id as string;
      items.push(
        s.status === "requested"
          ? {
              id: `signoff_requested:${s.id}`,
              kind: "signoff_requested",
              severity: "low",
              title: `${name.get(app)}: production sign-off waits for a Mynt admin`,
              detail: `For build ${short(s.build_id)}`,
              href: `/${app}`,
              at: iso(s.requested_at),
            }
          : {
              id: `signoff_decided:${s.id}`,
              kind: "signoff_decided",
              severity: s.status === "approved" ? "low" : "medium",
              title: `${name.get(app)}: production sign-off ${s.status}`,
              detail: `For build ${short(s.build_id)}${s.note ? `: ${s.note}` : ""}`,
              href: `/${app}`,
              at: iso(s.decided_at),
            },
      );
    }
    // Approved for an app not in production (production apps' failing checks are listed above), but stale now.
    const approved = new Set(
      (await rowsOf(db, `SELECT DISTINCT app_id::text AS app_id FROM ${T}.promotion_signoffs WHERE app_id::text = ANY($1) AND status = 'approved'`, [ids])).map((r) => r.app_id as string),
    );
    for (const app of apps)
      if (approved.has(app.id) && stages.get(app.id) !== "production" && (await staleSignoff(store, app)))
        items.push({
          id: `signoff_stale:${app.id}`,
          kind: "signoff_stale",
          severity: "medium",
          title: `${app.name}: its production sign-off no longer counts`,
          detail: "Its Solana programs or the money rails behind its products changed since a Mynt admin approved it; ask again (request_promotion_signoff)",
          href: `/${app.id}`,
          at: new Date(now).toISOString(),
        });
  }

  // Licences behind the workspace's products that lapse within 30 days.
  for (const l of await workspaceLicences(store, workspaceId, { status: "verified" })) {
    if (!l.expires_at) continue;
    const ends = new Date(l.expires_at).getTime();
    if (!Number.isFinite(ends) || ends < now || ends > now + LICENCE_DAYS * DAY) continue;
    const days = Math.ceil((ends - now) / DAY);
    items.push({
      id: `licence_expiring:${l.id}`,
      kind: "licence_expiring",
      severity: days <= 7 ? "high" : "medium",
      title: `${l.partner.name}'s ${l.type} licence expires in ${days} day(s)`,
      detail: `It covers the workspace's products in ${l.states.join(", ")}; they stop being covered there when it lapses unless it's renewed`,
      href: "/licences",
      at: new Date(ends).toISOString(),
    });
  }

  if (manager) {
    // Offboarding that gave up: someone who left may still hold access.
    for (const f of await rowsOf(
      db,
      `SELECT o.user_id::text AS user_id, o.started_at, o.error, u.name FROM ${T}.workspace_offboards o LEFT JOIN ${T}.users u ON u.id = o.user_id
       WHERE o.workspace_id::text = $1 AND o.status = 'failed' ORDER BY o.started_at DESC`,
      [workspaceId],
    ))
      items.push({
        id: `offboard_failed:${f.user_id}:${iso(f.started_at)}`,
        kind: "offboard_failed",
        severity: "high",
        title: `Cutting off ${f.name ?? "a former member"} didn't finish`,
        detail: `${String(f.error ?? "A step failed").slice(0, 300)}. A Mynt admin can run it again (retry_offboard)`,
        href: "/workspace?tab=members",
        at: iso(f.started_at),
      });
    // Webhooks whose secret no current member holds (rotated when someone left), or that were turned off.
    if (ids.length)
      for (const h of await rowsOf(
        db,
        `SELECT w.id::text AS id, w.app_id::text AS app_id, w.url, w.disabled_at, w.created_at,
           (SELECT max(a.created_at) FROM ${T}.audit_log a WHERE a.target = w.id::text AND a.action = 'webhook_secret_rotated_on_offboard') AS rotated_at
         FROM ${T}.webhooks w WHERE w.app_id::text = ANY($1)
           AND (w.disabled_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM ${T}.workspace_members m WHERE m.workspace_id::text = $2 AND m.user_id = w.last_secret_issued_to))`,
        [ids, workspaceId],
      )) {
        const off = !!h.disabled_at;
        items.push({
          id: `${off ? "webhook_disabled" : "webhook_secret_rotation"}:${h.id}`,
          kind: off ? "webhook_disabled" : "webhook_secret_rotation",
          severity: "medium",
          title: off ? `${name.get(h.app_id as string)}: a webhook was turned off` : `${name.get(h.app_id as string)}: a webhook's receiver needs a new signing secret`,
          detail: off
            ? `Deliveries to ${h.url} stopped when the person who made it left; turn it back on to confirm its receiver (enable_webhook)`
            : `Its secret was rotated out of reach of someone who left; rotate it (rotate_webhook_secret) and give ${h.url} the new one`,
          href: `/${h.app_id}`,
          at: iso(off ? h.disabled_at : (h.rotated_at ?? h.created_at)),
        });
      }
  }

  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  items.sort((a, b) => rank[a.severity] - rank[b.severity] || b.at.localeCompare(a.at));
  return { items };
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

export function registerAttentionTools(server: McpServer, store: Store, user: User) {
  server.registerTool(
    "get_workspace_attention",
    {
      title: "What needs attention in a workspace",
      description:
        "Developer (any member): what needs attention in one workspace, for your role in it, most severe first. Everyone: the workspace frozen or being archived, failed and blocked builds, production apps whose checks now fail, licences behind its products expiring within 30 days, and your own repository connections waiting for an admin. Owners and admins also: join requests (people not on Mynt who joined its organization), offboarding that didn't finish, webhooks turned off or whose receivers need a new secret, and production sign-offs asked, decided or no longer counting (a Mynt admin outside the workspace decides them). Each item has a studio link (href).",
      inputSchema: { workspace_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id }) => {
      const role = await workspaceRole(store.db, workspace_id, user.id);
      if (!role) return { ...json({ error: `No workspace of yours with id '${workspace_id}'` }), isError: true };
      return json(await workspaceAttention(store, user, workspace_id, { role }));
    },
  );
}
