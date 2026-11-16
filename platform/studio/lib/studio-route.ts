import { NextResponse } from "next/server";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { NotAllowedError } from "./mynt-client";
import { currentSession } from "./session";
import { finishSession } from "./session-response";
import type { Session } from "./session-store";
import { ensureRoles, isAuthError, logLine, rolesFresh, sessionIsDeveloper, ToolRefusedError } from "./studio-server";
import { connectStudio } from "./tokens";

const noStore = { "Cache-Control": "no-store" };

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore });

export const NOT_DEVELOPER = { error: "not_developer", message: "Mynt Studio is for developers. Ask a Mynt admin for the developer role." } as const;

// An API route that talks to Mynt as the signed-in developer: sign-in, the developer check, the
// connection and the usual answers (401, 403, 422 with Mynt's own message, 502), and the session
// saved at the end. `what` names the route in the server log (never its arguments or reply).
// `allowed` widens who the route serves (the liquidity routes also serve liquidity providers).
export async function asDeveloper(
  what: string,
  handle: (mynt: Client, session: Session) => Promise<NextResponse>,
  allowed: (session: Session) => boolean = sessionIsDeveloper,
): Promise<NextResponse> {
  const session = await currentSession();
  if (!session?.tokens) return json({ error: "auth_required" }, 401);
  // Roles read in the last few minutes that don't allow this route: refused at once, without
  // connecting to Mynt (a non-developer's page fires several of these; each used to open a
  // connection and wait on Mynt before being refused).
  if (rolesFresh(session) && !allowed(session)) return finishSession(json(NOT_DEVELOPER, 403), session);
  let mynt: Client | undefined;
  let res: NextResponse;
  try {
    mynt = await connectStudio(session);
    await ensureRoles(session, mynt);
    res = allowed(session)
      ? await handle(mynt, session)
      : json(NOT_DEVELOPER, 403);
  } catch (err) {
    if (isAuthError(err)) {
      session.tokens = undefined;
      res = json({ error: "auth_required" }, 401);
    } else if (err instanceof NotAllowedError) {
      res = json({ error: "not_allowed", message: err.message }, 403);
    } else if (err instanceof ToolRefusedError) {
      res = json({ error: "mynt_refused", message: err.message }, 422);
    } else {
      console.error(logLine(what, err));
      res = json({ error: "unreachable", message: "Couldn't reach Mynt. Please try again." }, 502);
    }
  } finally {
    await mynt?.close().catch(() => undefined);
  }
  return finishSession(res, session);
}
