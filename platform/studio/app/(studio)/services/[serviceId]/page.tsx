import type { Metadata } from "next";
import { Assistant } from "@/app/(studio)/[projectId]/assistant";
import { ProjectWelcome } from "@/components/assistant-ui/project-welcome";
import { loadAppName } from "@/lib/conversation";

// The tab title is the service's name (Mynt keeps a service as an app record of kind "service").
export async function generateMetadata({ params }: { params: Promise<{ serviceId: string }> }): Promise<Metadata> {
  const { serviceId } = await params;
  const name = await loadAppName(serviceId);
  return { title: name === "App" ? "Service" : name };
}

// A service's builder chat with no build open: the same chat an app has, with the service's id as its app id.
export default async function ServicePage({ params }: { params: Promise<{ serviceId: string }> }) {
  const { serviceId } = await params;
  return <Assistant kind="service" selectedProjectId={serviceId} selectedConversationId={null} welcome={<ProjectWelcome kind="service" />} />;
}
