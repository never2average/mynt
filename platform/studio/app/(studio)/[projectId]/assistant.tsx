"use client";

import { AssistantRuntimeProvider, useAuiState } from "@assistant-ui/react";
import {
  useAISDKRuntime,
  AssistantChatTransport,
} from "@assistant-ui/react-ai-sdk";
import { useChat } from "@ai-sdk/react";
import { type UIMessage } from "ai";
import { Thread } from "@/components/assistant-ui/thread";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { APP_TABS, PANEL_TAB_EVENT, type AppTab } from "@/lib/app-panel";
import type { SlashCommand } from "@/lib/slash-commands";

type ThreadState = {
  isEmpty: boolean;
  isRunning: boolean;
};

type BuildData = { buildId: string; started: boolean };

const EMPTY_MESSAGES: UIMessage[] = [];

const TAB_DESCRIPTIONS: Record<AppTab, string> = {
  preview: "Show the app's live preview",
  pnl: "Open the app's P&L",
  licences: "Open the licences behind the app",
  security: "Open the app's security checks",
  sdk: "Open the app's SDK",
  activity: "Open the app's activity",
};

// The builder chat's slash commands: open a panel tab (the workspace shell listens for
// "adorable:panel-tab"), or start a message to the coding agent. There's no /new: a message with no
// build selected may still steer the app's running build, so the chat can't promise a fresh one.
export const builderCommands = (projectId: string): SlashCommand[] => [
  ...APP_TABS.map((tab) => ({
    name: tab,
    description: TAB_DESCRIPTIONS[tab],
    run: () => window.dispatchEvent(new CustomEvent(PANEL_TAB_EVENT, { detail: { projectId, tab } })),
  })),
  { name: "fix", description: "Ask the coding agent to fix something", template: "Fix " },
  { name: "add", description: "Ask the coding agent to add a feature", template: "Add " },
];

// Mynt Studio: Adorable's chat panel, talking to Mynt's coding agent. Adorable's /api/chat ran
// its own model; the studio's sends each message to Mynt, which steers the app's running build
// or starts one, and streams back what the agent does. Each build is one conversation.
export const Assistant = ({
  initialMessages,
  selectedProjectId,
  selectedConversationId = null,
  onThreadStateChange,
  welcome,
}: {
  initialMessages?: UIMessage[];
  selectedProjectId: string;
  selectedConversationId?: string | null;
  onThreadStateChange?: (next: ThreadState) => void;
  welcome?: ReactNode;
}) => {
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
            // Only the new message: Mynt keeps the conversation, and the server reads just this.
            messages: options.messages.slice(-1),
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
  const commands = useMemo(() => builderCommands(projectId), [projectId]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadStateBridge
        projectId={projectId}
        onThreadStateChange={onThreadStateChange}
      />
      <Thread welcome={welcome} commands={commands} />
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
