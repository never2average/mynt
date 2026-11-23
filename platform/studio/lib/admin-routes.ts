// What the Admin area's routes (app/api/admin/*) share: whether this Mynt has a tool yet (an older Mynt answers
// { supported: false }, and the tab says it comes with Mynt's next update), and the write routes' checks (same
// origin, a uuid in the address, a strict body). Every route runs through asAdmin (lib/studio-route.ts): signed in,
// and an account Mynt says is an admin, or 404.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { NextResponse } from "next/server";
import { z } from "zod";
import { fromOwnOrigin } from "./session";
import { listMyntTools } from "./studio-server";
import { json } from "./studio-route";
import type { AdminTool } from "./studio-tools";

export const UNSUPPORTED = { supported: false } as const;

export async function hasTools(mynt: Client, ...names: AdminTool[]): Promise<boolean> {
  const have = new Set((await listMyntTools(mynt)).map((t) => t.name));
  return names.every((n) => have.has(n));
}

export const isUuid = (v: string) => z.string().uuid().safeParse(v).success;

// A write's request, checked before anything reaches Mynt: same origin, and a body the schema takes.
export async function writeBody<T>(req: Request, schema: z.ZodType<T>): Promise<{ ok: true; body: T } | { ok: false; res: NextResponse }> {
  if (!fromOwnOrigin(req)) return { ok: false, res: json({ error: "forbidden" }, 403) };
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return { ok: false, res: json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "That isn't a change this takes." }, 400) };
  return { ok: true, body: parsed.data };
}
