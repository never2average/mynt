// What My services' routes (app/api/vendor/*) share. Every route runs as the signed-in account and serves only an
// account Mynt gives the vendor role (anyone else: 403, before anything reaches Mynt's vendor tools). A write must come
// from the studio's own page, carry a body its schema takes, and name an offering of the caller's own firm
// (list_my_offerings is the firm's own list, whoever else the account could act for); Mynt checks it all again.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { NextResponse } from "next/server";
import { z } from "zod";
import { fromOwnOrigin } from "./session";
import type { Session } from "./session-store";
import { callStudioTool, listMyntTools } from "./studio-server";
import { asDeveloper, json } from "./studio-route";
import { isVendor } from "./vendor-area";

export const NOT_VENDOR = { error: "not_vendor", message: "My services is for service providers. Ask Mynt to add you to your firm with the vendor role." } as const;
export const UNSUPPORTED = { supported: false } as const;
export const NOT_YOURS = { error: "not_found", message: "That isn't one of your firm's services." } as const;

export const sessionIsVendor = (session: Session) => isVendor(session.roles ?? []);

export function asVendor(what: string, handle: (mynt: Client, session: Session) => Promise<NextResponse>): Promise<NextResponse> {
  return asDeveloper(what, handle, sessionIsVendor, () => json(NOT_VENDOR, 403));
}

export async function hasVendorTools(mynt: Client, ...names: string[]): Promise<boolean> {
  const have = new Set((await listMyntTools(mynt)).map((t) => t.name));
  return names.every((n) => have.has(n));
}

/** Whether `offeringId` is one of the caller's firm's own services. */
export async function ownOffering(mynt: Client, offeringId: string): Promise<boolean> {
  const mine = await callStudioTool(mynt, "list_my_offerings", {});
  return Array.isArray(mine) && mine.some((o) => typeof o === "object" && o !== null && (o as { id?: unknown }).id === offeringId);
}

export const isUuid = (v: string) => z.string().uuid().safeParse(v).success;

// A write's request, checked before anything reaches Mynt: same origin, and a body the schema takes.
export async function vendorWrite<T>(req: Request, schema: z.ZodType<T>): Promise<{ ok: true; body: T } | { ok: false; res: NextResponse }> {
  if (!fromOwnOrigin(req)) return { ok: false, res: json({ error: "forbidden" }, 403) };
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { ok: false, res: json({ error: "bad_request", message: i ? `${i.path.join(".") || "The form"}: ${i.message}` : "That isn't a change this takes." }, 400) };
  }
  return { ok: true, body: parsed.data };
}

/** An offering's write: own origin, a body, a uuid in the address, a vendor's session, and the firm's own offering. */
export async function offeringWrite<T>(
  req: Request,
  offeringId: string,
  schema: z.ZodType<T>,
  what: string,
  tool: string,
  handle: (mynt: Client, body: T) => Promise<NextResponse>,
): Promise<NextResponse> {
  const w = await vendorWrite(req, schema);
  if (!w.ok) return w.res;
  if (!isUuid(offeringId)) return json(NOT_YOURS, 404);
  return asVendor(what, async (mynt) => {
    if (!(await hasVendorTools(mynt, tool, "list_my_offerings"))) return json({ error: "unsupported", message: "This comes with Mynt's next update." }, 501);
    if (!(await ownOffering(mynt, offeringId))) return json(NOT_YOURS, 404);
    return handle(mynt, w.body);
  });
}
