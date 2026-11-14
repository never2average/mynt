"use client";

// Ask AI inside the search modal (components/studio-search.tsx), in place of the results:
// a header (Ask AI, Search to go back, New chat, Close), then the conversation, drawn with the
// studio's assistant-ui Thread (streamed markdown, the reads it made, Stop, follow-ups). Links to
// studio pages in an answer navigate in place and close the modal; the conversation stays. When
// no model is configured it says "AI is not configured" and search keeps working.
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { Loader2, MessageSquarePlus, Search, Sparkles, X } from "lucide-react";
import type { MouseEvent } from "react";

import { Thread } from "@/components/assistant-ui/thread";
import { Button } from "@/components/ui/button";

export type AskStatus = "loading" | "enabled" | "disabled";

export const NOT_CONFIGURED = "AI is not configured";

type Chat = UseChatHelpers<UIMessage>;

/** The panel's header; New chat clears the conversation. */
export function AskAiHeader({ onBack, onNewChat, onClose, canClear }: { onBack: () => void; onNewChat: () => void; onClose: () => void; canClear: boolean }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3" data-ask-header>
      <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
      <span className="text-sm font-medium">Ask AI</span>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <Button type="button" variant="ghost" size="sm" onClick={onBack} data-ask-back>
          <Search /> Search
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onNewChat} disabled={!canClear} data-ask-new-chat>
          <MessageSquarePlus /> New chat
        </Button>
        <Button type="button" variant="ghost" size="icon" className="size-8" onClick={onClose} aria-label="Close">
          <X />
        </Button>
      </div>
    </div>
  );
}

/** Ask AI when it can't answer: the notice, and a composer that can't be typed in. */
export function AskAiUnavailable({ status }: { status: Exclude<AskStatus, "enabled"> }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-between p-4" data-ask-status={status}>
      {status === "loading" ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Checking Ask AI…
        </p>
      ) : (
        <div className="rounded-lg border bg-muted/30 p-4 text-sm" role="status">
          <p className="font-medium">{NOT_CONFIGURED}</p>
          <p className="mt-1 text-muted-foreground">
            This studio has no model set up for Ask AI yet. Search still finds your pages, apps, members, licences and audit actions.
          </p>
        </div>
      )}
      <textarea
        disabled
        rows={2}
        aria-label="Message input"
        placeholder={status === "loading" ? "Ask about your apps…" : NOT_CONFIGURED}
        className="mt-4 w-full resize-none rounded-2xl border border-input bg-background px-4 py-3 text-sm opacity-60"
      />
    </div>
  );
}

function AskAiThread({ chat }: { chat: Chat }) {
  const runtime = useAISDKRuntime(chat);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread
        placeholder={chat.messages.length ? "Ask a follow-up…" : "Ask about your apps, builds, members or licences…"}
        welcome={
          <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col justify-center gap-1 px-2 pb-6">
            <p className="text-base font-medium">What do you want to know?</p>
            <p className="text-sm text-muted-foreground">Ask AI reads your Mynt data as you, and can&apos;t change anything.</p>
          </div>
        }
      />
    </AssistantRuntimeProvider>
  );
}

export function AskAiPanel({
  chat,
  status,
  onBack,
  onClose,
  onNavigate,
}: {
  chat: Chat;
  status: AskStatus;
  onBack: () => void;
  onClose: () => void;
  onNavigate: (href: string) => void;
}) {
  // An in-studio link in an answer: navigate in place (the conversation stays) and close the modal.
  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href") ?? "";
    if (!a || !href.startsWith("/") || href.startsWith("//") || a.target === "_blank" || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    onNavigate(href);
  };
  const newChat = () => {
    void chat.stop();
    chat.setMessages([]);
  };
  return (
    <div className="flex h-full min-h-0 flex-col" role="region" aria-label="Ask AI" data-ask-ai-panel onClickCapture={onClickCapture}>
      <AskAiHeader onBack={onBack} onNewChat={newChat} onClose={onClose} canClear={chat.messages.length > 0} />
      <div className="flex min-h-0 flex-1 flex-col">{status === "enabled" ? <AskAiThread chat={chat} /> : <AskAiUnavailable status={status} />}</div>
    </div>
  );
}
