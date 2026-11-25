// What My firm's routes (app/api/firm/*) share. Every route runs as the signed-in account and serves only an account
// Mynt granted the licence-provider role (anyone else: 403, before anything reaches Mynt's licence-provider tools). An
// admin's roles imply the role without a firm, so for an admin it's the role as granted (whoami's roles). Mynt's tools
// act for the caller's own firm and take no firm id, so nobody acts for another firm from here; a write must also come
// from the studio's own page, carry a body its schema takes, and name a sponsorship, licence, party or member request of
// that same firm (read from the firm's own lists). Every call goes through FIRM_TOOLS (callFirmTool), a list only a
// licence provider's session may use. Mynt checks it all again, and its refusals are shown in its words
// (an admin account can't revoke a sponsorship or decide who joins, even one that belongs to the firm).
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { NextResponse } from "next/server";
import { z } from "zod";
import { isLicenceProviderRole } from "./firm-area";
import { fromOwnOrigin } from "./session";
import type { Session } from "./session-store";
import { callFirmTool, callStudioTool, isAuthError, listMyntTools } from "./studio-server";
import type { FirmTool } from "./studio-tools";
import { asDeveloper, json } from "./studio-route";

export const NOT_LICENCE_PROVIDER = { error: "not_licence_provider", message: "My firm is for regulated firms' own people. Ask Mynt to add you to your firm with the licence-provider role." } as const;
export const UNSUPPORTED = { supported: false } as const;
export const NOT_YET = { error: "unsupported", message: "This comes with Mynt's next update." } as const;
export const NOT_YOURS = { error: "not_found", message: "That isn't your firm's." } as const;

const sessionMayBeLicenceProvider = (session: Session) => isLicenceProviderRole(session.roles ?? []);

/** Whether Mynt granted the account the licence-provider role (with standing at its firm): never the one an admin only implies. */
export async function grantedLicenceProvider(mynt: Client, session: Session): Promise<boolean> {
  const roles = session.roles ?? [];
  if (!isLicenceProviderRole(roles)) return false;
  if (!roles.includes("admin")) return true;
  try {
    const who = (await callStudioTool(mynt, "whoami")) as { roles?: unknown } | null;
    return Array.isArray(who?.roles) && who.roles.includes("license_provider");
  } catch (err) {
    if (isAuthError(err)) throw err;
    return false;
  }
}

export function asLicenceProvider(what: string, handle: (mynt: Client, session: Session) => Promise<NextResponse>): Promise<NextResponse> {
  return asDeveloper(what, async (mynt, session) => ((await grantedLicenceProvider(mynt, session)) ? handle(mynt, session) : json(NOT_LICENCE_PROVIDER, 403)), sessionMayBeLicenceProvider, () => json(NOT_LICENCE_PROVIDER, 403));
}

export async function hasFirmTools(mynt: Client, ...names: FirmTool[]): Promise<boolean> {
  const have = new Set((await listMyntTools(mynt)).map((t) => t.name));
  return names.every((n) => have.has(n));
}

export const isUuid = (v: string) => z.string().uuid().safeParse(v).success;

const idsIn = (list: unknown) => new Set((Array.isArray(list) ? list : []).flatMap((x) => (typeof x === "object" && x !== null && typeof (x as { id?: unknown }).id === "string" ? [(x as { id: string }).id] : [])));

/** Whether `id` is a sponsorship of the caller's own firm in that state (its own requests, or what it sponsors). */
export async function ownSponsorship(mynt: Client, session: Session, id: string, status: "pending" | "approved"): Promise<boolean> {
  const mine = status === "pending" ? await callFirmTool(mynt, session, "list_sponsorship_requests", { status: "pending" }) : await callFirmTool(mynt, session, "list_sponsored_products", {});
  return idsIn(mine).has(id);
}
/** Whether every id is a licence the caller's own firm holds. */
export async function ownLicences(mynt: Client, session: Session, ids: string[]): Promise<boolean> {
  const mine = (await callFirmTool(mynt, session, "list_my_licenses", {})) as { licences?: unknown } | null;
  const have = idsIn(mine?.licences);
  return ids.every((id) => have.has(id));
}
/** The caller's own firm's record (get_my_entity). */
export async function ownParty(mynt: Client, session: Session, partyId: string): Promise<boolean> {
  const firm = (await callFirmTool(mynt, session, "get_my_entity", {})) as { parties?: unknown } | null;
  return idsIn(firm?.parties).has(partyId);
}

/** A write: own origin, a body the schema takes, a licence provider's session, and a Mynt that has the tool. */
export async function firmWrite<T>(req: Request, schema: z.ZodType<T>, what: string, tools: FirmTool[], handle: (mynt: Client, body: T, session: Session) => Promise<NextResponse>): Promise<NextResponse> {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return json({ error: "bad_request", message: i ? `${i.path.join(".") || "The form"}: ${i.message}` : "That isn't a change this takes." }, 400);
  }
  return asLicenceProvider(what, async (mynt, session) => {
    if (!(await hasFirmTools(mynt, ...tools))) return json(NOT_YET, 501);
    return handle(mynt, parsed.data, session);
  });
}
