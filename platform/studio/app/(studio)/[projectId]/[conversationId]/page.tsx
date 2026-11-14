import { Assistant } from "../assistant";
import { ProjectWelcome } from "@/components/assistant-ui/project-welcome";
import type { Metadata } from "next";
import { loadAppName, loadConversation } from "@/lib/conversation";

export const dynamic = "force-dynamic";

// The tab title is the app's name.
export async function generateMetadata({ params }: { params: Promise<{ projectId: string }> }): Promise<Metadata> {
  const { projectId } = await params;
  return { title: await loadAppName(projectId) };
}

// One build of a project, as a conversation with Mynt's coding agent, beside its preview.
export default async function ConversationPage({
  params,
}: {
  params: Promise<{ projectId: string; conversationId: string }>;
}) {
  const { projectId, conversationId } = await params;
  const initialMessages = await loadConversation(projectId, conversationId);

  return (
    <Assistant
      initialMessages={initialMessages}
      selectedProjectId={projectId}
      selectedConversationId={conversationId}
      welcome={<ProjectWelcome />}
    />
  );
}
