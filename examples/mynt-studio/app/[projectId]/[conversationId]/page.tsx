import { Assistant } from "../../assistant";
import { ProjectWelcome } from "@/components/assistant-ui/project-welcome";

// One build of a project: its preview shows beside the (read-only, for now) chat.
export default async function ConversationPage({
  params,
}: {
  params: Promise<{ projectId: string; conversationId: string }>;
}) {
  const { projectId, conversationId } = await params;

  return (
    <Assistant
      selectedProjectId={projectId}
      selectedConversationId={conversationId}
      welcome={<ProjectWelcome />}
    />
  );
}
