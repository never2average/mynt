import { NextResponse, type NextRequest } from "next/server";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { enrolAmount } from "@/lib/events";
import { callMyntTool, connectMynt, NotSignedInError } from "@/lib/mynt";
import { queueAppEvent } from "@/lib/app-session";
import { currentSession, fromOwnOrigin } from "@/lib/session";

export const dynamic = "force-dynamic";

// The user tapped "Accept" on a card: enrol them through Mynt. This is the only place the
// app enrols anyone, and only on that explicit tap.
export async function POST(req: NextRequest) {
  if (!fromOwnOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const session = await currentSession();
  if (!session?.tokens) return NextResponse.json({ error: "auth_required" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { product_id?: unknown } | null;
  const productId = typeof body?.product_id === "string" ? body.product_id.trim() : "";
  if (!productId || productId.length > 200) return NextResponse.json({ error: "product_id is required" }, { status: 400 });
  // Only products this chat actually showed, on the terms the card showed.
  const card = session.transcript.find((item) => item.kind === "card" && item.card.product_id === productId);
  if (card?.kind !== "card") return NextResponse.json({ error: "That product wasn't offered in this chat." }, { status: 400 });
  if (session.accepted.includes(productId)) return NextResponse.json({ error: "You've already accepted this." }, { status: 409 });
  if (session.busy) return NextResponse.json({ error: "Still answering your last message." }, { status: 409 });
  session.busy = true;

  let mynt: Client | undefined;
  try {
    mynt = await connectMynt(session);
    const amount = enrolAmount(card.card);
    const outcome = await callMyntTool(mynt, "enroll_in_product", { product_id: productId, ...(amount ? { amount } : {}) });
    const text = outcome.isError
      ? `Mynt couldn't enrol you: ${outcome.text}`
      : `Done: you're enrolled in ${card.card.title}. It now shows in your Mynt enrolments.`;
    if (!outcome.isError) session.accepted.push(productId);
    session.transcript.push({ kind: "note", text, tone: outcome.isError ? "error" : "ok" });
    // Let the assistant know on the next turn. Mynt's reply is quoted as data.
    queueAppEvent(
      session,
      `The user tapped Accept on product ${JSON.stringify(productId)}. Mynt's enroll_in_product ${outcome.isError ? "failed" : "succeeded"} with: ${JSON.stringify(outcome.text.slice(0, 2000))}`,
    );
    return NextResponse.json({ ok: !outcome.isError, message: text }, { status: outcome.isError ? 422 : 200 });
  } catch (err) {
    if (err instanceof NotSignedInError) return NextResponse.json({ error: "auth_required" }, { status: 401 });
    console.error("accept failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't reach Mynt. Please try again." }, { status: 502 });
  } finally {
    session.busy = false;
    await mynt?.close().catch(() => undefined);
  }
}
