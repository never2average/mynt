"use client";

import {
  AssistantRuntimeProvider,
  useAuiState,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/thread";
import { useEffect } from "react";
import type { ReactNode } from "react";

type ThreadState = {
  isEmpty: boolean;
  isRunning: boolean;
};

const EMPTY_MESSAGES: ThreadMessageLike[] = [];

// Mynt Studio: the chat panel, read-only for now. Adorable ran its own model here (AI SDK,
// /api/chat with its own tools and keys). The studio has no model of its own: messages will go
// to Mynt's coding agent (start_build / steer_build) in the next step. Until then the thread is
// shown with its composer disabled.
export const Assistant = ({
  selectedProjectId = null,
  onThreadStateChange,
  welcome,
}: {
  selectedProjectId?: string | null;
  selectedConversationId?: string | null;
  onThreadStateChange?: (next: ThreadState) => void;
  welcome?: ReactNode;
}) => {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: EMPTY_MESSAGES,
    convertMessage: (message) => message,
    isDisabled: true,
    isRunning: false,
    onNew: async () => {
      throw new Error("Chatting with Mynt's coding agent is coming in the next step.");
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadStateBridge
        projectId={selectedProjectId}
        onThreadStateChange={onThreadStateChange}
      />
      <Thread welcome={welcome} disabledNote="Chatting with Mynt's coding agent is coming in the next step." />
    </AssistantRuntimeProvider>
  );
};

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
