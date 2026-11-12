import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callMyntTool } from "./mynt-client";
import type { Session } from "./session-store";
import { isDeveloper, parseStudioCall, parseToolText, rolesFrom } from "./studio-tools";

// A refusal whose message may be shown to the user: Mynt's own error message ({"error": "..."}),
// or a generic one. Raw replies and validation details are never shown.
export class ToolRefusedError extends Error {}

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
// Mynt's parsed reply; a tool error from Mynt is thrown as a ToolRefusedError.
export async function callStudioTool(client: Client, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const call = parseStudioCall(tool, args);
  if ("error" in call) throw new ToolRefusedError("The studio couldn't send that to Mynt.");
  const outcome = await callMyntTool(client, call.tool, call.args);
  if (outcome.isError) throw new ToolRefusedError(refusalMessage(outcome.text));
  return parseToolText(outcome.text);
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
