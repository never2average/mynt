"use client";

// A service's workspace (components/service-workspace.tsx) around its builder chat. As in an app's workspace, the
// sidebar folds to icons so the chat and the tabs get the room; its toggle brings it back.
import { useParams } from "next/navigation";
import { useEffect } from "react";
import { ServiceWorkspace } from "@/components/service-workspace";
import { useSidebar } from "@/components/ui/sidebar";

export function ServiceFrame({ children }: { children: React.ReactNode }) {
  const { serviceId } = useParams<{ serviceId: string }>();
  const { setOpen } = useSidebar();
  useEffect(() => {
    setOpen(false);
  }, [setOpen]);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-service-page>
      <ServiceWorkspace key={serviceId} serviceId={serviceId}>
        {children}
      </ServiceWorkspace>
    </div>
  );
}
