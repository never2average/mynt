import { Assistant } from "./assistant";
import type { Metadata } from "next";
import { ProjectWelcome } from "@/components/assistant-ui/project-welcome";
import { loadAppName } from "@/lib/conversation";

// The tab title is the app's name.
export async function generateMetadata({ params }: { params: Promise<{ projectId: string }> }): Promise<Metadata> {
  const { projectId } = await params;
  return { title: await loadAppName(projectId) };
}

export default async function RepoPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <Assistant
      selectedProjectId={projectId}
      selectedConversationId={null}
      welcome={<ProjectWelcome />}
    />
  );
}
