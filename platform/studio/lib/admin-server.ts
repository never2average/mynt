// The Admin area's gate, for its server page (app/(studio)/admin): whether the signed-in account is a Mynt admin, as
// Mynt says (its whoami's roles, read again when they're more than a few minutes old). Never a list of emails in the
// studio's settings: Mynt's admin role is given by Mynt's admins, in Mynt. Anyone else gets a 404 for /admin.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { currentSession } from "./session";
import { sessionStore } from "./session-store";
import { ensureRoles, logLine, rolesFresh, sessionIsAdmin } from "./studio-server";
import { connectStudio } from "./tokens";

export async function isAdminSession(): Promise<boolean> {
  const session = await currentSession();
  if (!session?.tokens) return false;
  if (rolesFresh(session)) return sessionIsAdmin(session);
  let mynt: Client | undefined;
  try {
    mynt = await connectStudio(session);
    await ensureRoles(session, mynt);
    await sessionStore().save(session);
  } catch (err) {
    console.error(logLine("checking the admin role", err));
    return false;
  } finally {
    await mynt?.close().catch(() => undefined);
  }
  return sessionIsAdmin(session);
}
