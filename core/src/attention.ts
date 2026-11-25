import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "./db.js";
import { effectiveStages, stageChecks, staleSignoff } from "./promotions.js";
import { PENDING } from "./repo-approvals.js";
import { overdueAuditsOfApps } from "./agreement-audits.js";
import { openBreachesOfApps } from "./agreement-slas.js";
import type { Store, User } from "./store.js";
import { workspaceLicences } from "./workspace-compliance.js";
import { workspaceRole, type WorkspaceRole } from "./workspaces.js";

// What needs someone's attention in one workspace, for the caller's role in it: the studio's attention list. Only the
// workspace's members ask, and only about that workspace: its apps, its licences, its own members' offboarding.
// Everyone sees the workspace frozen (its organization deleted in the identity provider) or being archived, failed
// and blocked builds, production apps whose checks now fail, licences expiring within 30 days, and their own
// repository connections waiting for an admin, and what the other firm did lately with the apps' agreements. Owners and admins also see join requests (people not on Mynt who
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

  // Oversight audits under the apps' agreements past their due date and not closed: each flags its app.
  for (const a of await overdueAuditsOfApps(store, ids, new Date(now)))
    items.push({
      id: `agreement_audit_overdue:${a.id}`,
      kind: "agreement_audit_overdue",
      severity: "high",
      title: `${name.get(a.app_id)}: ${a.name} is overdue`,
      detail: `${a.counterparty ?? "The licence provider"}'s oversight audit was due ${a.due_at.slice(0, 10)} and isn't closed; submit its evidence or answer its findings`,
      href: `/audits?tab=agreements&agreement=${a.agreement_id}`,
      at: a.due_at,
    });

  // Service levels under the apps' agreements missed and not resolved yet (agreement-slas.ts): each flags its app.
  for (const b of await openBreachesOfApps(store, ids))
    items.push({
      id: `agreement_sla_breach:${b.id}`,
      kind: "agreement_sla_breach",
      severity: "medium",
      title: `${name.get(b.app_id)}: ${b.metric} SLA breached`,
      detail: `${b.counterparty ?? "The licence provider"}'s service level (target ${b.target}) measured ${b.measured_value} from ${b.period_start} to ${b.period_end}; resolve it once it's dealt with`,
      href: "/licences?tab=sla",
      at: b.at,
    });

  // Agreements a licence provider proposed for one of the workspace's apps, waiting for its answer (app-agreements.ts
  // propose_workspace_agreement): the owners and admins accept or decline them.
  {
    const KIND: Record<string, string> = { program: "program agreement", data_sharing: "data-sharing agreement", msa: "master services agreement", sla: "service-level agreement", vendor: "vendor contract" };
    const waiting = await rowsOf(
      db,
      `SELECT g.id::text AS id, g.app_id::text AS app_id, g.kind, g.proposed_at, e.name AS firm FROM ${T}.app_agreements g LEFT JOIN ${T}.entities e ON e.id = g.counterparty_entity_id
        WHERE g.status = 'proposed' AND g.proposed_by_side = 'counterparty' AND g.app_id::text = ANY($1)
        ORDER BY g.proposed_at DESC LIMIT 50`,
      [ids],
    );
    for (const g of waiting)
      items.push({
        id: `app_agreement_proposed:${g.id}`,
        kind: "app_agreement_proposed",
        severity: manager ? "medium" : "low",
        title: `${name.get(g.app_id as string)}: ${g.firm ?? "A licence provider"} proposed a ${KIND[g.kind as string] ?? "agreement"}`,
        detail: manager ? "Review it, then accept or decline it on the Licences page's Business Agreements tab" : "It waits for an owner or admin to accept or decline it",
        href: "/licences?tab=business-agreements",
        at: iso(g.proposed_at),
      });
  }

  // The other firm's side of the apps' agreements, lately: accepted, declined, signed or ended by it (app-agreements.ts).
  // This is how the app's side hears of them; their own actions they know. Signing is the owners' and admins' to do.
  if (ids.length) {
    const WORDS: Record<string, string> = { accept_app_agreement: "accepted", decline_app_agreement: "declined", sign_app_agreement: "signed", terminate_app_agreement: "ended" };
    // Program agreements signed by e-signature (agreement-esign.ts): the other firm's signature on the document, the
    // document completed (signed by both: the agreement is signed), declined at signing, or expired or cancelled at
    // the service (the agreement ends). A cancellation Mynt made itself, when someone ended the agreement, is that
    // termination's, so it isn't listed twice.
    const ESIGN: Record<string, string> = { esign_signer_signed: "signed", esign_completed: "completed", esign_declined: "declined", esign_expired: "expired", esign_canceled: "cancelled" };
    const done = await rowsOf(
      db,
      `SELECT l.id::text AS id, l.action, l.target, l.details, l.created_at, g.kind, g.status, g.app_signed_at, doc.app_signed_at AS esign_app_signed_at, e.name AS firm
       FROM ${T}.audit_log l JOIN ${T}.app_agreements g ON g.id::text = l.target LEFT JOIN ${T}.entities e ON e.id = g.counterparty_entity_id
         LEFT JOIN ${T}.app_agreement_documents doc ON doc.agreement_id = g.id
       WHERE l.action = ANY($1) AND l.details->>'app_id' = ANY($2) AND l.created_at > now() - make_interval(days => $3)
         AND (l.action IN ('esign_completed', 'esign_declined', 'esign_expired', 'esign_canceled') OR (l.action IN ('accept_app_agreement', 'decline_app_agreement') AND l.details->>'side' IS DISTINCT FROM 'app') OR l.details->>'side' = 'counterparty')
       ORDER BY l.created_at DESC LIMIT 50`,
      [[...Object.keys(WORDS), ...Object.keys(ESIGN)], ids, RECENT_DAYS],
    );
    for (const d of done) {
      const details = (d.details ?? {}) as Record<string, unknown>;
      const app = String(details.app_id);
      const KINDS: Record<string, string> = { program: "program agreement", vendor: "vendor contract", data_sharing: "data-sharing agreement", msa: "master services agreement", sla: "service-level agreement" };
      const what = KINDS[String(d.kind)] ?? "agreement";
      const esign = String(d.action) in ESIGN;
      const ended = d.action === "terminate_app_agreement" || d.action === "esign_expired" || d.action === "esign_canceled";
      const declined = d.action === "decline_app_agreement" || d.action === "esign_declined";
      const yoursToSign = d.status === "accepted" && !d.app_signed_at && !d.esign_app_signed_at;
      items.push({
        id: `app_agreement:${d.id}`,
        kind: "app_agreement_update",
        severity: ended && d.kind === "program" ? "high" : ended || declined || (yoursToSign && manager) ? "medium" : "low",
        title: esign
          ? d.action === "esign_signer_signed"
            ? `${name.get(app)}: ${d.firm ?? "the other firm"} signed the ${what} by e-signature`
            : d.action === "esign_completed"
              ? `${name.get(app)}: the ${what} with ${d.firm ?? "the other firm"} is signed by both sides`
              : d.action === "esign_declined"
                ? `${name.get(app)}: the ${what} with ${d.firm ?? "the other firm"} was declined at signing`
                : `${name.get(app)}: the ${what} with ${d.firm ?? "the other firm"} ended: its e-signature document ${ESIGN[d.action as string]}`
          : `${name.get(app)}: ${d.firm ?? "the other firm"} ${WORDS[d.action as string]} the ${what}`,
        detail: esign && ended
          ? `${d.kind === "program" ? "Production needs a signed program agreement with each product's sponsor: propose a new one" : "Propose a new one if you still need it"}`
          : esign && d.action === "esign_completed"
            ? "Signed by both sides. Download the signed copy on the app's Agreements tab"
          : ended
          ? `Reason: ${String(details.reason ?? "none given")}.${d.kind === "program" ? " Production needs a signed program agreement with each product's sponsor: propose a new one" : ""}`
          : declined
            ? `${details.note ? `Their note: ${String(details.note)}. ` : ""}Propose another if you still need one`
            : yoursToSign
              ? manager ? "It waits for your side's signature: Sign it on the app's Agreements tab" : "It waits for an owner or admin to sign it"
              : d.status === "signed" ? "Signed by both sides" : `It's ${d.status}`,
        href: `/${app}?tab=agreements`,
        at: iso(d.created_at),
      });
    }
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
        "Developer (any member): what needs attention in one workspace, for your role in it, most severe first. Everyone: the workspace frozen or being archived, failed and blocked builds, production apps whose checks now fail (a program agreement that ended or expired among them: the app stays in production, flagged), what the other firm did lately with the apps' agreements (accepted, declined, signed or ended them), oversight audits under its apps' agreements past their due date and not closed, licences behind its products expiring within 30 days, and your own repository connections waiting for an admin. Owners and admins also: join requests (people not on Mynt who joined its organization), offboarding that didn't finish, webhooks turned off or whose receivers need a new secret, and production sign-offs asked, decided or no longer counting (a Mynt admin outside the workspace decides them). Each item has a studio link (href).",
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
