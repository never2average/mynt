import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { callMyntTool, NotSignedInError } from "./mynt-client";
import type { Session } from "./session-store";
import { isDeveloper, isMyntAdmin, parseAdminCall, parseFirmCall, parseStudioCall, parseToolText, rolesFrom, type AdminTool, type FirmTool } from "./studio-tools";

// A refusal whose message may be shown to the user: Mynt's own error message ({"error": "..."}),
// or a generic one. Raw replies and validation details are never shown.
export class ToolRefusedError extends Error {}

// Mynt answered the call with an error. `raw` is its reply as sent (never shown to the user).
export class MyntRefusedError extends ToolRefusedError {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
  }
}

// Mynt's refusals that come before it changes anything: checks of permission, existence, state
// and budget, worded as in Mynt's src/builds.ts (a test keeps them in step with it). Any other
// error may have come after a build was inserted or a steer was written.
export const MYNT_REFUSALS_BEFORE_ANY_CHANGE = [
  /Coding-agent builds aren't enabled/,
  /No (app|build) of yours with id/,
  /Monthly build budget used up/,
  /is more than this month's remaining build budget/,
  /Repository '[^']*' isn't connected/,
  /Build is [a-z_]+; only a running agent can be steered/,
  /Products not available: /, // create_app, checked before the app is created
];

// The MCP server rejecting a call's arguments, before the tool runs.
const SDK_REFUSALS = [/Input validation error|Invalid arguments for tool/];

const REFUSED_BEFORE_ANY_CHANGE = [...MYNT_REFUSALS_BEFORE_ANY_CHANGE, ...SDK_REFUSALS];

// Whether an error means the call certainly had no effect: the studio never sent it (the
// arguments didn't pass the allow-list), Mynt rejected it as a JSON-RPC request (unknown tool,
// invalid parameters), or Mynt refused it with one of the checks above.
export function certainlyNotDone(err: unknown): boolean {
  if (err instanceof MyntRefusedError) return REFUSED_BEFORE_ANY_CHANGE.some((re) => re.test(err.raw));
  if (err instanceof McpError) return err.code === ErrorCode.InvalidParams || err.code === ErrorCode.MethodNotFound;
  return err instanceof ToolRefusedError;
}

export const GENERIC_REFUSAL = "Mynt couldn't do that just now. Please try again.";
const MAX_SHOWN = 500;

// What a person may be shown of Mynt's refusal: Mynt's own message, cleaned (no control
// characters) and capped, from any of the shapes Mynt answers with ({"error": "..."},
// {"error": {"message": "..."}}, {"message": "..."}, or plain text such as an argument
// validation error). Only an empty message, or text that looks like a stack trace or names
// server files, falls back to the generic line.
const INTERNALS = /Traceback|\n\s+at |\bat [\w.<>]+ \(|[\\/](srv|opt|home|usr|app|var)[\\/]|\.(py|ts|js|mjs|cjs):\d+/;
function messageIn(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") return null;
  const o = data as { error?: unknown; message?: unknown };
  if (typeof o.error === "string") return o.error;
  if (o.error && typeof o.error === "object" && typeof (o.error as { message?: unknown }).message === "string") return (o.error as { message: string }).message;
  if (typeof o.message === "string") return o.message;
  return null;
}
export function refusalMessage(text: string): string {
  const raw = messageIn(parseToolText(text));
  if (raw === null || !raw.trim() || INTERNALS.test(raw)) return GENERIC_REFUSAL;
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return GENERIC_REFUSAL;
  return clean.length > MAX_SHOWN ? `${clean.slice(0, MAX_SHOWN)}…` : clean;
}

// The only way the studio's server calls Mynt: through the STUDIO_TOOLS allow-list. Returns
// Mynt's parsed reply; a tool error from Mynt is thrown as a MyntRefusedError.
export async function callStudioTool(client: Client, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const call = parseStudioCall(tool, args);
  if ("error" in call) throw new ToolRefusedError("The studio couldn't send that to Mynt.");
  const outcome = await callMyntTool(client, call.tool, call.args);
  if (outcome.isError) throw new MyntRefusedError(refusalMessage(outcome.text), outcome.text);
  return parseToolText(outcome.text);
}

// The Admin area's only way to call Mynt: an admin tool (ADMIN_TOOLS), for a session whose account Mynt says is an
// admin. Anyone else's call never leaves the studio. Mynt checks the role again.
export async function callAdminTool(client: Client, session: Session, tool: AdminTool, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!isMyntAdmin(session.roles ?? [])) throw new ToolRefusedError("That's for Mynt admins.");
  const call = parseAdminCall(tool, args);
  if ("error" in call) throw new ToolRefusedError("The studio couldn't send that to Mynt.");
  const outcome = await callMyntTool(client, call.tool, call.args);
  if (outcome.isError) throw new MyntRefusedError(refusalMessage(outcome.text), outcome.text);
  return parseToolText(outcome.text);
}

// My firm's only way to call Mynt: a regulated firm's tool (FIRM_TOOLS), for a session whose account Mynt says is a
// licence provider. Anyone else's call never leaves the studio. Mynt checks the role, and whose firm it is, again.
export async function callFirmTool(client: Client, session: Session, tool: FirmTool, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!(session.roles ?? []).includes("license_provider")) throw new ToolRefusedError("That's for a regulated firm's own people.");
  const call = parseFirmCall(tool, args);
  if ("error" in call) throw new ToolRefusedError("The studio couldn't send that to Mynt.");
  const outcome = await callMyntTool(client, call.tool, call.args);
  if (outcome.isError) throw new MyntRefusedError(refusalMessage(outcome.text), outcome.text);
  return parseToolText(outcome.text);
}

export const sessionIsAdmin = (session: Session) => isMyntAdmin(session.roles ?? []);

// Asks Mynt who the session's user is and remembers their roles (and id) on the session.
export async function refreshRoles(session: Session, client: Client): Promise<string[]> {
  const data = (await callStudioTool(client, "whoami")) as { id?: unknown; name?: unknown; email?: unknown } | null;
  session.roles = rolesFrom(data);
  session.rolesAt = Date.now();
  if (typeof data?.id === "string" && data.id) session.userId = data.id;
  if (typeof data?.name === "string" && data.name) session.name = data.name.slice(0, 200);
  if (typeof data?.email === "string" && data.email) session.email = data.email.slice(0, 320);
  return session.roles;
}

// Roles can change (an admin grants or revokes developer), so they're read again from Mynt
// every few minutes, not once per session. Mynt still checks each call itself.
export const ROLES_MAX_AGE_MS = 5 * 60 * 1000;

// Whether the session's roles were read from Mynt recently enough to act on without asking again.
export const rolesFresh = (session: Session, now = Date.now()) => Boolean(session.roles && session.rolesAt && now - session.rolesAt < ROLES_MAX_AGE_MS);

export async function ensureRoles(session: Session, client: Client, now = Date.now()): Promise<string[]> {
  if (session.roles && session.rolesAt && now - session.rolesAt < ROLES_MAX_AGE_MS) return session.roles;
  return refreshRoles(session, client);
}

// Mynt no longer accepts the session's sign-in (expired, revoked): the user must sign in again.
export function isAuthError(err: unknown): boolean {
  return err instanceof NotSignedInError || err instanceof UnauthorizedError || (err instanceof StreamableHTTPError && err.code === 401);
}

export const sessionIsDeveloper = (session: Session) => isDeveloper(session.roles ?? []);

// Every tool this user's Mynt lists (names, descriptions and input schemas), to see what it offers.
export async function listMyntTools(client: Client): Promise<{ name: string; description?: string; inputSchema?: unknown }[]> {
  const tools: { name: string; description?: string; inputSchema?: unknown }[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })));
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

// A line for the server log about a failed call: never the reply or arguments (preview URLs
// in a reply are capabilities).
export function logLine(what: string, err: unknown): string {
  const name = err instanceof Error ? err.name : "error";
  // A bug in the studio's own code (a TypeError reading a reply it didn't expect) names what and
  // where, so it can be found from the log: the message (no arguments or replies are in these)
  // and the first frame's function and file. Other errors (Mynt's, the network's) stay a name only.
  if (err instanceof TypeError || err instanceof RangeError || err instanceof SyntaxError) {
    const message = err.message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);
    const frame = /\n\s+at (?:(\S+) )?\(?([^()\s]*?)([^/\\()\s]+):(\d+):\d+\)?/.exec(err.stack ?? "");
    const where = frame ? ` at ${frame[1] ?? "?"} (${frame[3]}:${frame[4]})` : "";
    return `${what} failed (${name}: ${message}${where})`;
  }
  return `${what} failed (${name})`;
}
