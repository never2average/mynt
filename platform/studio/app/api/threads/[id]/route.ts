import { replay, SessionId, type StoredEvent } from "@/lib/chat-sessions";
import { asChatUser } from "@/lib/chat-sessions-server";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool } from "@/lib/studio-server";
import { json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// One of the signed-in user's chats (get_chat_session), replayed: its messages as last saved and each
// draft's latest outcome. Someone else's chat is refused, as Mynt answers a missing one.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const id = SessionId.safeParse((await params).id);
  if (!id.success) return json({ error: "not_found" }, 404);
  return asChatUser("reading a chat", async (mynt) => {
    const reply = await callStudioTool(mynt, "get_chat_session", { id: id.data });
    const s = isObj(reply) && isObj(reply.session) ? reply.session : {};
    const events = (isObj(reply) && Array.isArray(reply.events) ? reply.events : []).filter(isObj) as unknown as StoredEvent[];
    const { messages, outcomes } = replay(events);
    return json({ id: id.data, kind: s.kind, title: s.title, updatedAt: s.updated_at, metadata: isObj(s.metadata) ? s.metadata : {}, lastSeq: s.last_seq ?? null, messages, outcomes });
  });
}

// Deletes one of the user's chats, with everything in it (delete_chat_session).
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const id = SessionId.safeParse((await params).id);
  if (!id.success) return json({ error: "not_found" }, 404);
  return asChatUser("deleting a chat", async (mynt) => {
    await callStudioTool(mynt, "delete_chat_session", { id: id.data });
    return json({ deleted: true });
  });
}
