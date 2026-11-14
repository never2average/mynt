"use client";

import { useProjectConversations } from "@/lib/project-conversations-context";
import type { FC } from "react";
import { ChatWelcome } from "@/components/chat-welcome";

// Examples for an app with no builds yet. A chip only fills the composer: sending starts a build.
export const BUILDER_EXAMPLES = ["Add a savings goal screen", "Show recent transactions", "Make it work well on phones"] as const;

export const ProjectWelcome: FC = () => {
  const { conversations, onSelectConversation, projectId } =
    useProjectConversations();

  const hasConversations = projectId && conversations.length > 0;

  return (
    <ChatWelcome title="" subtitle={projectId && !hasConversations ? "No builds for this app yet." : undefined} chips={projectId && !hasConversations ? BUILDER_EXAMPLES : []} fill>
        {hasConversations && (
          <div className="mt-8 w-full max-w-(--thread-max-width) animate-in delay-100 duration-300 fade-in slide-in-from-bottom-2">
            <p className="mb-2 px-3 text-xs font-medium text-muted-foreground/50">
              Builds
            </p>
            <div className="divide-y divide-border/50">
              {conversations.map((conversation) => {
                const title = conversation.title?.trim();
                return (
                  <button
                    key={conversation.id}
                    type="button"
                    onClick={() => onSelectConversation(conversation.id)}
                    className="flex w-full items-center rounded-md px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                  >
                    <span className="truncate">
                      {title || "Untitled build"}
                    </span>
                    <span className="ml-auto shrink-0 pl-3 text-xs text-muted-foreground/50">
                      {conversation.status}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
    </ChatWelcome>
  );
};
