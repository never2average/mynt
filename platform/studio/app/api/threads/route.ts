import type { NextRequest } from "next/server";
import { readCapped, TOO_LARGE } from "@/lib/ai-route";
import { ChatKindSchema, SaveRequest } from "@/lib/chat-sessions";
import { asChatUser } from "@/lib/chat-sessions-server";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool } from "@/lib/studio-server";
import { json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";
// A save carries at most 100 events of at most 128 KB each (Mynt's limits); a body over this is refused here.
export const MAX_BODY_BYTES = 1024 * 1024;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// The signed-in user's own chats of a kind (?kind=product|earn), newest first, without their messages
// (list_chat_sessions); ?q= keeps those whose title or words match, each with the words around the match.
export async function GET(req: NextRequest) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const kind = ChatKindSchema.safeParse(req.nextUrl.searchParams.get("kind"));
  if (!kind.success) return json({ error: "bad_request", message: "Say which chats: kind=product or kind=earn." }, 400);
  const query = req.nextUrl.searchParams.get("q")?.trim().slice(0, 200) || undefined;
  return asChatUser("listing chats", async (mynt) => {
    const reply = await callStudioTool(mynt, "list_chat_sessions", { kind: kind.data, ...(query ? { query } : {}) });
    const sessions = isObj(reply) && Array.isArray(reply.sessions) ? reply.sessions : [];
    return json({
      threads: sessions.filter(isObj).map((s) => ({
        id: s.id,
        kind: s.kind,
        title: s.title,
        updatedAt: s.updated_at,
        metadata: isObj(s.metadata) ? s.metadata : {},
        ...(query ? { snippet: typeof s.snippet === "string" ? s.snippet : null } : {}),
      })),
    });
  });
}

// Saves one chat: starts its session on Mynt if it isn't there yet (create_chat_session answers the one
// already there), then appends the events (append_chat_events, which skips any it already has). What's
// in the chat is never logged.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const raw = await readCapped(req, MAX_BODY_BYTES);
  if (raw === TOO_LARGE) return json({ error: "too_large", message: "That conversation is too long to keep. Start a new one." }, 413);
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const parsed = SaveRequest.safeParse(body);
  if (!parsed.success) return json({ error: "bad_request" }, 400);
  const { id, kind, title, events } = parsed.data;
  return asChatUser("saving a chat", async (mynt) => {
    await callStudioTool(mynt, "create_chat_session", { id, kind, ...(title ? { title } : {}) });
    let lastSeq: unknown = null;
    if (events.length) {
      const reply = await callStudioTool(mynt, "append_chat_events", { id, events });
      lastSeq = isObj(reply) ? reply.last_seq : null;
    }
    return json({ saved: true, id, lastSeq });
  });
}
