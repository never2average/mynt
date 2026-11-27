"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { useProjectConversations } from "@/lib/project-conversations-context";
import type { FC } from "react";
import { BuildStatus } from "@/components/app-panel-tabs";
import { ChatWelcome } from "@/components/chat-welcome";
import { Section } from "@/components/dashboard-panels";
import { Button } from "@/components/ui/button";

// Examples for an app with no builds yet. A chip only fills the composer: sending starts a build.
export const BUILDER_EXAMPLES = ["Add a savings goal screen", "Show recent transactions", "Make it work well on phones"] as const;

// The newest builds the welcome lists; the rest are on the Builds page.
export const WELCOME_BUILDS = 5;

// Examples for a service with no builds yet.
export const SERVICE_BUILDER_EXAMPLES = ["Add Mynt's vendor service endpoint", "Verify Mynt's signature on every request", "Answer the fixture requests"] as const;

// `kind`: an app's builds, or a service's (the same chat and builds, at /services/<id>).
export const ProjectWelcome: FC<{ kind?: "app" | "service" }> = ({ kind = "app" }) => {
  const { conversations, onSelectConversation, projectId } =
    useProjectConversations();

  const hasConversations = projectId && conversations.length > 0;

  return (
    <ChatWelcome title="" subtitle={projectId && !hasConversations ? `No builds for this ${kind} yet.` : undefined} chips={projectId && !hasConversations ? (kind === "service" ? SERVICE_BUILDER_EXAMPLES : BUILDER_EXAMPLES) : []} fill>
        {hasConversations && (
          <div className="mt-8 w-full max-w-(--thread-max-width) animate-in delay-100 duration-300 fade-in slide-in-from-bottom-2">
            <Section id="welcome-builds" title="Builds">
              <ul className="flex flex-col divide-y" data-welcome-builds>
                {conversations.slice(0, WELCOME_BUILDS).map((conversation) => {
                  const title = conversation.title?.trim();
                  return (
                    <li key={conversation.id}>
                      <button
                        type="button"
                        onClick={() => onSelectConversation(conversation.id)}
                        className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-muted/50"
                        data-build={conversation.id}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {title || "Untitled build"}
                        </span>
                        <BuildStatus status={conversation.status} />
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="flex justify-end border-t pt-3" data-view-all="/builds">
                <Button asChild variant="outline" size="sm">
                  <Link href="/builds">
                    View all
                    <ChevronRight />
                  </Link>
                </Button>
              </div>
            </Section>
          </div>
        )}
    </ChatWelcome>
  );
};
