// The platform admin's gate, for its layout and pages (app/(platform)): whether the signed-in account is a Mynt admin,
// as Mynt says (its whoami's roles, read again when they're more than a few minutes old). Never a list of emails in the
// studio's settings: Mynt's admin role is given by Mynt's admins, in Mynt. Anyone else gets a 404 for /platform.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { notFound } from "next/navigation";
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

// The platform admin's layout and pages: a 404 for anyone who isn't a Mynt admin, signed in or not (proxy.ts has
// already sent a signed-out visit to sign-in). Nothing says there's a platform admin here.
export async function requireAdminPage(): Promise<void> {
  if (!(await isAdminSession())) notFound();
}
