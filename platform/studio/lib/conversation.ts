import type { UIMessage } from "ai";
import { buildToMessages, type HistoryMessage } from "./chat";
import { connectMynt } from "./mynt-client";
import { currentSession } from "./session";
import { sessionStore } from "./session-store";
import { callStudioTool, logLine } from "./studio-server";

// History messages in the AI SDK's shape, as the chat panel draws them.
export function toUIMessages(history: HistoryMessage[]): UIMessage[] {
  return history.map((m) => ({
    id: m.id,
    role: m.role,
    parts: m.parts.map((p, i) =>
      p.kind === "text"
        ? { type: "text" as const, text: p.text }
        : ({ type: `tool-${p.toolName}`, toolCallId: `${m.id}-${i}`, state: "output-available", input: p.input, output: {} } as UIMessage["parts"][number]),
    ),
  }));
}

// One of the user's builds of this app, as a conversation. Empty when it can't be read (not
// signed in, not theirs, not this app's, or Mynt unreachable): the page then just shows the
// project's welcome.
export async function loadConversation(appId: string, buildId: string): Promise<UIMessage[]> {
  const session = await currentSession();
  if (!session?.tokens) return [];
  try {
    const mynt = await connectMynt(session);
    try {
      const build = (await callStudioTool(mynt, "get_build", { build_id: buildId })) as { app_id?: unknown } | null;
      if (build?.app_id !== appId) return [];
      const activity = await callStudioTool(mynt, "get_build_activity", { build_id: buildId, limit: 200 });
      return toUIMessages(buildToMessages(build, activity));
    } finally {
      await mynt.close().catch(() => undefined);
    }
  } catch (err) {
    console.error(logLine("loading a conversation", err));
    return [];
  } finally {
    await sessionStore()
      .save(session)
      .catch(() => undefined);
  }
}
