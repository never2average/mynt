"use client";

import {
  AssistantRuntimeProvider,
  useAuiState,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  useAISDKRuntime,
  AssistantChatTransport,
} from "@assistant-ui/react-ai-sdk";
import { useChat } from "@ai-sdk/react";
import { type UIMessage } from "ai";
import { Thread } from "@/components/assistant-ui/thread";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";

type ThreadState = {
  isEmpty: boolean;
  isRunning: boolean;
};

type BuildData = { buildId: string; started: boolean };

const EMPTY_MESSAGES: UIMessage[] = [];

// Mynt Studio: Adorable's chat panel, talking to Mynt's coding agent. Adorable's /api/chat ran
// its own model; the studio's sends each message to Mynt, which steers the app's running build
// or starts one, and streams back what the agent does. Each build is one conversation.
//
// With no app open there's nothing to build on yet, so the panel is shown read-only.
export const Assistant = ({
  initialMessages,
  selectedProjectId = null,
  selectedConversationId = null,
  onThreadStateChange,
  welcome,
}: {
  initialMessages?: UIMessage[];
  selectedProjectId?: string | null;
  selectedConversationId?: string | null;
  onThreadStateChange?: (next: ThreadState) => void;
  welcome?: ReactNode;
}) => {
  if (!selectedProjectId) {
    return (
      <ReadOnlyAssistant
        onThreadStateChange={onThreadStateChange}
        welcome={welcome}
        note="Open one of your apps to chat with its coding agent."
      />
    );
  }
  return (
    <ProjectAssistant
      key={`${selectedProjectId}:${selectedConversationId ?? "new"}`}
      projectId={selectedProjectId}
      conversationId={selectedConversationId}
      initialMessages={initialMessages ?? EMPTY_MESSAGES}
      onThreadStateChange={onThreadStateChange}
      welcome={welcome}
    />
  );
};

function ProjectAssistant({
  projectId,
  conversationId,
  initialMessages,
  onThreadStateChange,
  welcome,
}: {
  projectId: string;
  conversationId: string | null;
  initialMessages: UIMessage[];
  onThreadStateChange?: (next: ThreadState) => void;
  welcome?: ReactNode;
}) {
  // The build this conversation is about; set by the first reply when a message starts one.
  const activeBuildIdRef = useRef<string | null>(conversationId);

  const dispatchProjectsUpdated = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("adorable:projects-updated", { detail: { projectId } }),
    );
  }, [projectId]);

  const handleData = useCallback(
    (part: { type: string; data?: unknown }) => {
      if (part.type !== "data-build") return;
      const data = part.data as BuildData | undefined;
      if (!data?.buildId || data.buildId === activeBuildIdRef.current) return;
      activeBuildIdRef.current = data.buildId;
      // Show this build's address and preview without reloading the chat.
      window.history.replaceState(
        window.history.state,
        "",
        `/${projectId}/${data.buildId}`,
      );
      window.dispatchEvent(
        new CustomEvent("adorable:active-conversation", {
          detail: { projectId, conversationId: data.buildId },
        }),
      );
      dispatchProjectsUpdated();
    },
    [projectId, dispatchProjectsUpdated],
  );

  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: async (options) => ({
          body: {
            messages: options.messages,
            projectId,
            conversationId: activeBuildIdRef.current,
          },
        }),
      }),
    [projectId],
  );

  const chat = useChat<UIMessage>({
    id: `${projectId}:${conversationId ?? "new"}`,
    transport,
    messages: initialMessages,
    onData: handleData,
    onFinish: dispatchProjectsUpdated,
  });

  const runtime = useAISDKRuntime(chat);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadStateBridge
        projectId={projectId}
        onThreadStateChange={onThreadStateChange}
      />
      <Thread welcome={welcome} />
    </AssistantRuntimeProvider>
  );
}

const NO_MESSAGES: ThreadMessageLike[] = [];

function ReadOnlyAssistant({
  onThreadStateChange,
  welcome,
  note,
}: {
  onThreadStateChange?: (next: ThreadState) => void;
  welcome?: ReactNode;
  note: string;
}) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: NO_MESSAGES,
    convertMessage: (message) => message,
    isDisabled: true,
    isRunning: false,
    onNew: async () => {
      throw new Error(note);
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadStateBridge
        projectId={null}
        onThreadStateChange={onThreadStateChange}
      />
      <Thread welcome={welcome} disabledNote={note} />
    </AssistantRuntimeProvider>
  );
}

function ThreadStateBridge({
  projectId,
  onThreadStateChange,
}: {
  projectId: string | null;
  onThreadStateChange?: (next: ThreadState) => void;
}) {
  const isEmpty = useAuiState(({ thread }) => thread.isEmpty);
  const isRunning = useAuiState(({ thread }) => thread.isRunning);

  useEffect(() => {
    onThreadStateChange?.({ isEmpty, isRunning });
    window.dispatchEvent(
      new CustomEvent("adorable:thread-state", {
        detail: { projectId, isRunning },
      }),
    );
  }, [isEmpty, isRunning, onThreadStateChange, projectId]);

  return null;
}
