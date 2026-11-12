import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { isDeveloper, parseToolText, rolesFrom } from "./developer";
import { callMyntTool } from "./mynt";
import type { Session } from "./session-store";

// Asks Mynt who the session's user is and remembers their roles (and id) on the session. Mynt
// stays the authority: it only lists developer tools to developers, so a stale role here can at
// worst show the console to someone whose calls Mynt then refuses.
export async function refreshRoles(session: Session, client: Client): Promise<string[]> {
  const me = await callMyntTool(client, "whoami", {});
  if (me.isError) throw new Error("whoami failed");
  const data = parseToolText(me.text) as { id?: unknown } | null;
  session.roles = rolesFrom(data);
  if (typeof data?.id === "string" && data.id) session.userId = data.id;
  return session.roles;
}

export const sessionIsDeveloper = (session: Session) => isDeveloper(session.roles ?? []);
