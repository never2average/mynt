"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import type { ProjectItem } from "@/lib/project-types";
import { ProjectConversationsProvider } from "@/lib/project-conversations-context";
import { ProjectsProvider } from "@/lib/projects-context";
import { Loader2Icon } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { AppTopBar, DEVICES, type Device } from "@/components/app-top-bar";
import { ChatWorkspaceShell } from "@/components/chat-workspace-shell";

import { AppInfoTab } from "@/components/app-panel-tabs";
import { APP_TABS, APP_TAB_LABELS, type AppTab } from "@/lib/app-panel";

// The builder's right-hand tabs: the live preview (the default; its controls are in the top bar),
// then the app's P&L, Licences, Security, SDK and Activity, each live and for this app only.
// Promoting is an action (the top bar's button and its sheet), not a tab.
export const BUILDER_TABS = APP_TABS.map((id) => ({ id, label: APP_TAB_LABELS[id] }));

/** Build statuses that are still changing, so the list refreshes while one runs. */
const ACTIVE_BUILD = /^(queued|provisioning|coding|auditing|checking|previewing|pushing|verifying)$/;

type ThreadStateDetail = {
  projectId: string | null;
  isRunning: boolean;
};

export function ProjectWorkspaceShell({
  projectId,
  children,
  selectedConversationIdOverride,
}: {
  projectId: string | null;
  children: React.ReactNode;
  selectedConversationIdOverride?: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const selectedConversationId =
    selectedConversationIdOverride ??
    pathname.split("/").filter(Boolean)[1] ??
    null;

  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [threadIsRunning, setThreadIsRunning] = useState(false);
  const hasActiveBuild = projects.some((project) =>
    project.conversations.some((build) => ACTIVE_BUILD.test(build.status)),
  );

  // The signed-in developer's Mynt apps and their builds, read from Mynt. One load at a time:
  // a call while one is running shares it, so mounting, polling and events never send
  // overlapping requests (each one may refresh the session's sign-in).
  const inFlightRef = useRef<Promise<void> | null>(null);
  const loadProjects = useCallback(() => {
    inFlightRef.current ??= fetchProjects().finally(() => {
      inFlightRef.current = null;
    });
    return inFlightRef.current;
  }, []);

  const fetchProjects = async () => {
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as {
        projects?: ProjectItem[];
        error?: string;
        message?: string;
      } | null;
      if (response.ok) {
        setProjects(data?.projects ?? []);
        setProjectsError(null);
      } else if (response.status === 401) {
        window.dispatchEvent(new Event("mynt:signed-out"));
      } else {
        setProjectsError(data?.message ?? "Couldn't load your apps.");
      }
    } catch {
      setProjectsError("Couldn't reach the studio. Check your connection.");
    }
    setProjectsLoading(false);
  };

  // On mount, and again when another app is opened.
  useEffect(() => {
    void loadProjects();
  }, [loadProjects, projectId]);

  useEffect(() => {
    if (!threadIsRunning && !hasActiveBuild) return;
    const interval = window.setInterval(() => {
      void loadProjects();
    }, 10000);
    return () => {
      window.clearInterval(interval);
    };
  }, [loadProjects, threadIsRunning, hasActiveBuild]);

  useEffect(() => {
    const handleProjectsUpdated = () => {
      void loadProjects();
    };

    window.addEventListener("adorable:projects-updated", handleProjectsUpdated);
    return () => {
      window.removeEventListener(
        "adorable:projects-updated",
        handleProjectsUpdated,
      );
    };
  }, [loadProjects]);

  useEffect(() => {
    const handleThreadState = (event: Event) => {
      const customEvent = event as CustomEvent<ThreadStateDetail>;
      const detail = customEvent.detail;
      if (!detail) return;
      if (projectId && detail.projectId && detail.projectId !== projectId)
        return;
      setThreadIsRunning(Boolean(detail.isRunning));
    };

    window.addEventListener(
      "adorable:thread-state",
      handleThreadState as EventListener,
    );
    return () => {
      window.removeEventListener(
        "adorable:thread-state",
        handleThreadState as EventListener,
      );
    };
  }, [projectId]);

  const handleSelectProject = useCallback(
    (nextProjectId: string) => {
      router.push(`/${nextProjectId}`);
    },
    [router],
  );

  const selectedProject = projectId
    ? (projects.find((project) => project.id === projectId) ?? null)
    : null;
  const selectedBuild =
    selectedProject?.conversations.find(
      (build) => build.id === selectedConversationId,
    ) ?? null;
  const previewUrl = selectedConversationId
    ? (selectedBuild?.previewUrl ?? null)
    : (selectedProject?.previewUrl ?? null);
  const showWorkspacePanel = Boolean(projectId);
  const isMobile = useIsMobile();
  const [mobileView, setMobileView] = useState<"chat" | "preview">("chat");

  // Reset to chat view when navigating away
  useEffect(() => {
    if (!projectId) setMobileView("chat");
  }, [projectId]);


  const conversationsContextValue = useMemo(
    () => ({
      projectId,
      conversations: selectedProject?.conversations ?? [],
      onSelectConversation: (conversationId: string) => {
        if (projectId) {
          router.push(`/${projectId}/${conversationId}`);
        }
      },
    }),
    [projectId, selectedProject?.conversations, router],
  );

  const projectsContextValue = useMemo(
    () => ({
      projects,
      isLoading: projectsLoading,
      error: projectsError,
      onSelectProject: handleSelectProject,
    }),
    [projects, projectsLoading, projectsError, handleSelectProject],
  );

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [panelTab, setPanelTab] = useState<AppTab>("preview");
  // Another app opens on its preview.
  useEffect(() => {
    setPanelTab("preview");
  }, [projectId]);
  const panelVisible = !isMobile || mobileView === "preview";
  const [device, setDevice] = useState<Device>("desktop");

  const goBack = () => {
    if (selectedConversationId) {
      window.dispatchEvent(new CustomEvent("adorable:go-to-project", { detail: { projectId } }));
      router.push(`/${projectId}`);
    } else {
      window.dispatchEvent(new Event("adorable:go-home"));
      router.push("/");
    }
  };

  return (
    <ProjectsProvider value={projectsContextValue}>
      <ProjectConversationsProvider value={conversationsContextValue}>
        <ChatWorkspaceShell
          // The app's own top bar (in place of the page header)
          topBar={
            projectId && (
              <AppTopBar
                appId={selectedProject ? projectId : null}
                appName={selectedProject?.name ?? (projectsLoading ? null : "App")}
                stage={selectedProject?.stage ?? null}
                backLabel={selectedConversationId ? "All builds" : "All apps"}
                onBack={goBack}
                previewUrl={showWorkspacePanel ? previewUrl : null}
                iframeRef={iframeRef}
                device={device}
                onDevice={setDevice}
                isMobile={isMobile}
                mobileView={mobileView}
                onShowChat={() => setMobileView("chat")}
              />
            )
          }
          chat={children}
          showPanel={showWorkspacePanel}
          tabs={BUILDER_TABS.map((t) => ({
            ...t,
            content:
              t.id === "preview" ? (
                previewUrl ? (
                  <AppPreview previewUrl={previewUrl} iframeRef={iframeRef} width={isMobile ? null : DEVICES[device].width} />
                ) : (
                  <PreviewPlaceholder />
                )
              ) : projectId ? (
                <AppInfoTab key={`${projectId}:${t.id}`} appId={projectId} tab={t.id} active={panelTab === t.id && panelVisible} />
              ) : null,
          }))}
          tab={panelTab}
          onTab={(id) => setPanelTab(id as AppTab)}
          isMobile={isMobile}
          mobileView={mobileView === "preview" ? "panel" : "chat"}
          onMobileView={(v) => setMobileView(v === "panel" ? "preview" : "chat")}
        />
      </ProjectConversationsProvider>
    </ProjectsProvider>
  );
}

function PreviewPlaceholder() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b bg-muted/20 px-2">
        <div className="size-6 rounded bg-muted-foreground/8" />
        <div className="size-6 rounded bg-muted-foreground/8" />
        <div className="size-6 rounded bg-muted-foreground/8" />
        <div className="ml-1 h-7 flex-1 rounded-md bg-muted/50" />
      </div>

      <p className="px-8 pt-6 text-center text-sm text-muted-foreground/60">
        No preview yet. A build&apos;s preview shows here once Mynt&apos;s
        coding agent has one running.
      </p>
      <div className="flex-1 overflow-hidden p-8">
        <div className="mx-auto max-w-md space-y-8">
          <div className="flex items-center justify-between">
            <div className="h-4 w-20 animate-pulse rounded bg-muted/60" />
            <div className="flex gap-4">
              <div className="h-3 w-12 animate-pulse rounded bg-muted/40" />
              <div className="h-3 w-12 animate-pulse rounded bg-muted/40" />
              <div className="h-3 w-12 animate-pulse rounded bg-muted/40" />
            </div>
          </div>

          <div className="flex flex-col items-center gap-4 py-6">
            <div className="h-6 w-56 animate-pulse rounded bg-muted/50" />
            <div className="h-4 w-40 animate-pulse rounded bg-muted/30" />
            <div className="mt-2 h-9 w-28 animate-pulse rounded-lg bg-muted/40" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="space-y-2 rounded-lg border border-muted/30 p-3"
              >
                <div className="h-3 w-full animate-pulse rounded bg-muted/40" />
                <div className="h-2 w-3/4 animate-pulse rounded bg-muted/25" />
                <div className="h-2 w-1/2 animate-pulse rounded bg-muted/20" />
              </div>
            ))}
          </div>
        </div>
      </div>

    </div>
  );
}

function AppPreview({
  previewUrl,
  iframeRef,
  width,
}: {
  previewUrl: string;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  /** The top bar's device width in pixels; null fills the panel. */
  width: number | null;
}) {
  const [iframeLoaded, setIframeLoaded] = useState(false);

  useEffect(() => {
    setIframeLoaded(false);
  }, [previewUrl]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div
        className={cn("relative mx-auto min-h-0 w-full flex-1 bg-muted/30", width !== null && "border-x shadow-sm")}
        style={width !== null ? { maxWidth: width } : undefined}
        data-preview-width={width ?? "full"}
      >
        {!iframeLoaded && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background">
            <div className="flex flex-col items-center gap-3">
              <Loader2Icon className="size-6 animate-spin text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground/40">
                Loading preview…
              </p>
            </div>
          </div>
        )}
        {/* The preview runs on its own origin, never the studio's. No top navigation. */}
        <iframe
          ref={iframeRef}
          src={previewUrl}
          title="App preview"
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
          referrerPolicy="no-referrer"
          className={cn(
            "h-full w-full transition-opacity duration-300",
            iframeLoaded ? "opacity-100" : "opacity-0",
          )}
          onLoad={() => setIframeLoaded(true)}
        />
      </div>
    </div>
  );
}
