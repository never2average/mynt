import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callMyntTool } from "./mynt-client";
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
  if (typeof data?.id === "string" && data.id) session.userId = data.id;
  return session.roles;
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
