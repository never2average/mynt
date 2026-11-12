import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { callMyntTool, NotSignedInError } from "./mynt-client";
import type { Session } from "./session-store";
import { isDeveloper, parseStudioCall, parseToolText, rolesFrom } from "./studio-tools";

export class ToolRefusedError extends Error {}

// The only way the studio's server calls Mynt: through the STUDIO_TOOLS allow-list. Returns
// Mynt's parsed reply; a tool error from Mynt is thrown with Mynt's own message.
export async function callStudioTool(client: Client, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const call = parseStudioCall(tool, args);
  if ("error" in call) throw new ToolRefusedError(call.error);
  const outcome = await callMyntTool(client, call.tool, call.args);
  const data = parseToolText(outcome.text);
  if (outcome.isError) {
    const message = data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string" ? (data as { error: string }).error : outcome.text;
    throw new ToolRefusedError(message || `${call.tool} failed`);
  }
  return data;
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

// A line for the server log about a failed call: never the reply or arguments (preview URLs
// in a reply are capabilities).
export function logLine(what: string, err: unknown): string {
  return `${what} failed (${err instanceof Error ? err.name : "error"})`;
}
