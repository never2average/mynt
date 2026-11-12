import { Assistant } from "../../assistant";
import { ProjectWelcome } from "@/components/assistant-ui/project-welcome";
import { loadConversation } from "@/lib/conversation";

export const dynamic = "force-dynamic";

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
