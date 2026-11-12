import { z } from "zod";

// Which of Mynt's tools the studio may call for the signed-in user, with what arguments. Mynt
// checks everything again (who owns what, roles, limits); these keep junk off the wire and keep
// the studio to its job. Anything not listed (vm_access, app_run, admin tools...) can't be
// called from the studio at all.
//
// Writing tools join the list with the screens that use them. The chat starts and steers
// builds; shipping (finish_build), stopping, sandbox commands, creating apps, connecting
// repositories and hosting changes come later.

const id = z.string().trim().min(1).max(200);
// A compose app's service (e.g. api or web), as Mynt checks it (src/hosting-tools.ts).
const service = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/).optional();
const repository = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name");

export const STUDIO_TOOLS = {
  // apps and catalogue
  whoami: z.object({}).strict(),
  list_my_apps: z.object({}).strict(),
  list_buildable_products: z
    .object({ product_line: z.string().max(80).optional(), query: z.string().max(200).optional(), access_mode: z.string().max(40).optional() })
    .strict(),
  get_product: z.object({ id }).strict(),
  // New app: a draft app on the products picked, then a build for it.
  create_app: z
    .object({
      name: z.string().trim().min(1).max(80),
      description: z.string().trim().min(1).max(4000),
      audience: z.string().trim().min(1).max(500),
      product_ids: z.array(id).min(1).max(20),
    })
    .strict(),
  // The dashboard: money moved, customers, hand-offs and build spend across the user's apps.
  get_developer_dashboard: z.object({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional() }).strict(),
  // repositories
  list_repositories: z.object({}).strict(),
  // builds
  list_builds: z.object({ status: z.string().max(40).optional(), app_id: id.optional() }).strict(),
  get_build: z.object({ build_id: id }).strict(),
  get_build_activity: z
    .object({ build_id: id, limit: z.number().int().min(1).max(200).optional(), after: z.number().int().min(0).optional() })
    .strict(),
  // The chat: a message starts a build for the app, or steers the one running. `mode` and
  // `continue_from` are sent only where Mynt offers session builds (lib/chat.ts).
  start_build: z
    .object({
      goal: z.string().trim().min(10).max(4000),
      app_id: id,
      repository: repository.optional(),
      mode: z.literal("session").optional(),
      continue_from: id.optional(),
    })
    .strict(),
  steer_build: z.object({ build_id: id, message: z.string().trim().min(3).max(4000) }).strict(),
  // sandbox (reading only)
  sandbox_files: z.object({ build_id: id, path: z.string().max(1000).optional() }).strict(),
  sandbox_diff: z.object({ build_id: id }).strict(),
  // hosting (reading only)
  hosting_status: z.object({}).strict(),
  app_status: z.object({ app_id: id }).strict(),
  app_logs: z.object({ app_id: id, tail: z.number().int().min(1).max(2000).optional(), service }).strict(),
} as const;

export type StudioTool = keyof typeof STUDIO_TOOLS;

export function isStudioTool(name: unknown): name is StudioTool {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(STUDIO_TOOLS, name);
}

export type StudioCall = { tool: StudioTool; args: Record<string, unknown> } | { error: string };

// Checks a tool name and its arguments against the allow-list.
export function parseStudioCall(tool: unknown, args: unknown): StudioCall {
  if (!isStudioTool(tool)) return { error: "That tool isn't available in the studio" };
  const parsed = STUDIO_TOOLS[tool].safeParse(args ?? {});
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ") };
  return { tool, args: parsed.data as Record<string, unknown> };
}

// whoami's effective_roles (developers include innovators); roles as a fallback.
export function rolesFrom(whoami: unknown): string[] {
  const w = (whoami ?? {}) as { effective_roles?: unknown; roles?: unknown };
  const list = Array.isArray(w.effective_roles) ? w.effective_roles : Array.isArray(w.roles) ? w.roles : [];
  return list.filter((r): r is string => typeof r === "string");
}

// The studio is for people who build apps on Mynt. Mynt re-checks every call.
export const isDeveloper = (roles: string[]) => roles.includes("developer") || roles.includes("innovator") || roles.includes("admin");

// Mynt replies with JSON text; anything else is kept as text.
export function parseToolText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
