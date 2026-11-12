import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { callMyntTool, NotSignedInError } from "./mynt-client";
import type { Session } from "./session-store";
import { isDeveloper, parseStudioCall, parseToolText, rolesFrom } from "./studio-tools";

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

// Mynt's refusals that come before it changes anything (src/builds.ts, src/server.ts): checks
// of permission, existence, state, arguments and budget. Any other error may have come after a
// build was inserted or a steer was written.
const REFUSED_BEFORE_ANY_CHANGE = [
  /Coding-agent builds aren't enabled/,
  /No (app|build) of yours with id/,
  /Monthly build budget used up/,
  /is more than this month's remaining build budget/,
  /Repository '[^']*' isn't connected/,
  /Build is [a-z_]+; only a running agent can be steered/,
  /Input validation error|Invalid arguments for tool/,
];

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

// Mynt's error message, if the reply is Mynt's {"error": "..."} shape; otherwise the generic one.
export function refusalMessage(text: string): string {
  const data = parseToolText(text);
  const error = data && typeof data === "object" ? (data as { error?: unknown }).error : undefined;
  if (typeof error !== "string" || !error.trim()) return GENERIC_REFUSAL;
  const clean = error.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
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

// Asks Mynt who the session's user is and remembers their roles (and id) on the session.
export async function refreshRoles(session: Session, client: Client): Promise<string[]> {
  const data = (await callStudioTool(client, "whoami")) as { id?: unknown } | null;
  session.roles = rolesFrom(data);
  session.rolesAt = Date.now();
  if (typeof data?.id === "string" && data.id) session.userId = data.id;
  return session.roles;
}

// Roles can change (an admin grants or revokes developer), so they're read again from Mynt
// every few minutes, not once per session. Mynt still checks each call itself.
export const ROLES_MAX_AGE_MS = 5 * 60 * 1000;

export async function ensureRoles(session: Session, client: Client, now = Date.now()): Promise<string[]> {
  if (session.roles && session.rolesAt && now - session.rolesAt < ROLES_MAX_AGE_MS) return session.roles;
  return refreshRoles(session, client);
}

// Mynt no longer accepts the session's sign-in (expired, revoked): the user must sign in again.
export function isAuthError(err: unknown): boolean {
  return err instanceof NotSignedInError || err instanceof UnauthorizedError || (err instanceof StreamableHTTPError && err.code === 401);
}

export const sessionIsDeveloper = (session: Session) => isDeveloper(session.roles ?? []);

// Every tool this user's Mynt lists (names and input schemas), to see what it offers.
export async function listMyntTools(client: Client): Promise<{ name: string; inputSchema?: unknown }[]> {
  const tools: { name: string; inputSchema?: unknown }[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools.map((t) => ({ name: t.name, inputSchema: t.inputSchema })));
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

// A line for the server log about a failed call: never the reply or arguments (preview URLs
// in a reply are capabilities).
export function logLine(what: string, err: unknown): string {
  return `${what} failed (${err instanceof Error ? err.name : "error"})`;
}
