"use client";

// An app's workspace (Adorable's chat beside the preview). The sidebar folds to icons here, so
// the chat and the preview get the room; its toggle brings it back.
import { useEffect } from "react";
import { useSidebar } from "@/components/ui/sidebar";
import { WorkspaceFrame } from "./workspace-frame";

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { setOpen } = useSidebar();
  useEffect(() => {
    setOpen(false);
  }, [setOpen]);
  return <WorkspaceFrame>{children}</WorkspaceFrame>;
}
