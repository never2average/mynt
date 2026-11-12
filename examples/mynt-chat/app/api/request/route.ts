import { NextResponse, type NextRequest } from "next/server";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callMyntTool, connectMynt, NotSignedInError } from "@/lib/mynt";
import { queueAppEvent } from "@/lib/app-session";
import { currentSession, fromOwnOrigin } from "@/lib/session";

export const dynamic = "force-dynamic";

// The user tapped "Send request" on a request the assistant proposed: record it on Mynt with
// request_product, exactly as the card showed it. Innovators read requests, so this is the only
// place the app sends one, and only on that explicit tap.
export async function POST(req: NextRequest) {
  if (!fromOwnOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const session = await currentSession();
  if (!session?.tokens) return NextResponse.json({ error: "auth_required" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { request_id?: unknown } | null;
  const requestId = typeof body?.request_id === "string" ? body.request_id.trim() : "";
  const proposed = session.transcript.find((item) => item.kind === "request" && item.id === requestId);
  if (!requestId || proposed?.kind !== "request") return NextResponse.json({ error: "That request wasn't proposed in this chat." }, { status: 400 });
  if (session.sentRequests.includes(requestId)) return NextResponse.json({ error: "You've already sent this request." }, { status: 409 });
  if (session.busy) return NextResponse.json({ error: "Still answering your last message." }, { status: 409 });
  session.busy = true;

  let mynt: Client | undefined;
  try {
    mynt = await connectMynt(session);
    const outcome = await callMyntTool(mynt, "request_product", { ...proposed.request, currency: "INR", region: "IN" });
    const text = outcome.isError
      ? `Mynt couldn't send your request: ${outcome.text}`
      : "Sent. Mynt's product teams can now see your need (not your name), and their offers will show up here.";
    if (!outcome.isError) session.sentRequests.push(requestId);
    session.transcript.push({ kind: "note", text, tone: outcome.isError ? "error" : "ok" });
    queueAppEvent(
      session,
      `The user tapped Send request on the proposed request ${JSON.stringify(requestId)}. Mynt's request_product ${outcome.isError ? "failed" : "succeeded"} with: ${JSON.stringify(outcome.text.slice(0, 2000))}`,
    );
    return NextResponse.json({ ok: !outcome.isError, message: text }, { status: outcome.isError ? 422 : 200 });
  } catch (err) {
    if (err instanceof NotSignedInError) return NextResponse.json({ error: "auth_required" }, { status: 401 });
    console.error("request failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't reach Mynt. Please try again." }, { status: 502 });
  } finally {
    session.busy = false;
    await mynt?.close().catch(() => undefined);
  }
}
