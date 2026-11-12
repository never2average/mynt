import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

export { callMyntTool, connectMynt, NotAllowedError, NotSignedInError, type ToolOutcome } from "./mynt-client";

// Mynt tools this app offers to Claude. Tools that act for the user are deliberately absent:
// enrolment (enroll_in_product and friends) only happens when the user taps "Accept" on a
// card, and request_product only when they tap "Send request" on a proposed request, never on
// the model's say-so. Tools the signed-in user doesn't have are simply not listed by Mynt.
export const CHAT_TOOLS = new Set([
  "whoami",
  "list_products",
  "get_product",
  "get_product_regime",
  "list_categories",
  "list_regions",
  "list_product_categories",
  "list_offers",
  "list_my_enrollments",
  "list_my_product_requests",
]);

export async function listChatTools(client: Client): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools.filter((t) => CHAT_TOOLS.has(t.name)));
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

