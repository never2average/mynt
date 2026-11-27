import type { Metadata } from "next";
import { Assistant } from "@/app/(studio)/[projectId]/assistant";
import { ProjectWelcome } from "@/components/assistant-ui/project-welcome";
import { loadAppName, loadConversation } from "@/lib/conversation";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ serviceId: string }> }): Promise<Metadata> {
  const { serviceId } = await params;
  const name = await loadAppName(serviceId);
  return { title: name === "App" ? "Service" : name };
}

// One build of a service, as a conversation with Mynt's coding agent, beside the service's tabs.
export default async function ServiceBuildPage({ params }: { params: Promise<{ serviceId: string; conversationId: string }> }) {
  const { serviceId, conversationId } = await params;
  const { messages: initialMessages, follow, build } = await loadConversation(serviceId, conversationId);
  return (
    <Assistant
      kind="service"
      initialMessages={initialMessages}
      follow={follow}
      build={build}
      selectedProjectId={serviceId}
      selectedConversationId={conversationId}
      welcome={<ProjectWelcome kind="service" />}
    />
  );
}
