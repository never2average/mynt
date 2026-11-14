"use client";

// An app's top bar, in place of the page header inside an app, as Adorable's workspace top bar
// lays it out (back to the app's builds or all apps, then the preview's browser controls) with
// what Lovable-style builders add: the app's name and stage, the preview's width (desktop,
// tablet, phone) and opening the preview in a new tab. Search and New app stay at the right as
// icon buttons. Sticky. Beside the stage is the stage control: Promote to Staging or Production
// (and Move back, for owners and admins), which opens the promotion checks
// (components/promotion-view.tsx). The studio has no code view yet.
import { useEffect, useState } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronLeftIcon,
  ExternalLinkIcon,
  MonitorIcon,
  RotateCwIcon,
  SmartphoneIcon,
  TabletIcon,
} from "lucide-react";

import { StageControl } from "@/components/promotion-view";
import { NewAppButton } from "@/components/site-header";
import { SearchTrigger } from "@/components/studio-search";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { STAGE_LABELS, type Stage } from "@/lib/workspaces";

export const DEVICES = {
  desktop: { label: "Desktop", width: null, icon: MonitorIcon },
  tablet: { label: "Tablet", width: 768, icon: TabletIcon },
  mobile: { label: "Phone", width: 390, icon: SmartphoneIcon },
} as const;
export type Device = keyof typeof DEVICES;

/** Keeps the preview URL's query (a token-gated preview needs it) on every path. */
export function withPreviewQuery(previewUrl: string, next: string): string {
  try {
    const url = new URL(next);
    url.search = new URL(previewUrl).search;
    return url.toString();
  } catch {
    return previewUrl;
  }
}

const iconButton =
  "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none";

export type AppTopBarProps = {
  /** The app's id once it has loaded: the stage control (promotions) needs it. */
  appId?: string | null;
  appName: string | null; // null while the app loads
  stage: Stage | null;
  backLabel: string;
  onBack: () => void;
  previewUrl: string | null;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  device: Device;
  onDevice: (device: Device) => void;
  /** Phones: the bar shows the name, and the preview's controls only while the preview shows. */
  isMobile?: boolean;
  mobileView?: "chat" | "preview";
  onShowChat?: () => void;
};

export function AppTopBar({ appId = null, appName, stage, backLabel, onBack, previewUrl, iframeRef, device, onDevice, isMobile = false, mobileView = "chat", onShowChat }: AppTopBarProps) {
  const showPreviewControls = Boolean(previewUrl) && (!isMobile || mobileView === "preview");
  return (
    <header className="sticky top-0 z-20 flex h-11 shrink-0 items-center gap-1 border-b bg-background px-2" data-app-top-bar>
      <SidebarTrigger className="size-7" />
      <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" data-toggle-separator />
      {isMobile && mobileView === "preview" ? (
        <button type="button" onClick={onShowChat} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground">
          <ChevronLeftIcon className="size-3.5" /> Chat
        </button>
      ) : (
        <button
          type="button"
          onClick={onBack}
          title={backLabel}
          aria-label={backLabel}
          className="flex shrink-0 items-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <ChevronLeftIcon className="size-4" />
        </button>
      )}
      <div className="flex min-w-0 items-center gap-2 pr-2">
        <h1 className="truncate text-sm font-semibold" data-app-name>
          {appName ?? "Loading app…"}
        </h1>
        {stage && (
          <Badge variant="outline" className="shrink-0 font-normal" data-app-stage={stage}>
            {STAGE_LABELS[stage]}
          </Badge>
        )}
        {/* Promote / Move back: a screen with Mynt's checks, never a drag between folders. */}
        {appId && appName && stage && !(isMobile && mobileView === "preview") && <StageControl appId={appId} appName={appName} stage={stage} />}
      </div>

      {showPreviewControls && previewUrl ? (
        <PreviewControls previewUrl={previewUrl} iframeRef={iframeRef} device={device} onDevice={onDevice} showDevices={!isMobile} />
      ) : (
        <div className="flex-1" />
      )}

      <div className="flex shrink-0 items-center gap-1 pl-1">
        <SearchTrigger compact />
        <NewAppButton compact />
      </div>
    </header>
  );
}

/** The preview's controls: back, forward, reload, its path, its width, and open in a new tab. */
export function PreviewControls({
  previewUrl,
  iframeRef,
  device,
  onDevice,
  showDevices = true,
}: {
  previewUrl: string;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  device: Device;
  onDevice: (device: Device) => void;
  showDevices?: boolean;
}) {
  const pathOf = (url: string) => {
    try {
      return new URL(url).pathname;
    } catch {
      return "/";
    }
  };
  const [urlValue, setUrlValue] = useState(() => pathOf(previewUrl));
  useEffect(() => setUrlValue(pathOf(previewUrl)), [previewUrl]);

  const baseUrl = (() => {
    try {
      const u = new URL(previewUrl);
      return `${u.protocol}//${u.host}`;
    } catch {
      return previewUrl;
    }
  })();
  const current = withPreviewQuery(previewUrl, `${baseUrl}${urlValue.startsWith("/") ? urlValue : `/${urlValue}`}`);

  const navigate = (path: string) => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    setUrlValue(normalizedPath);
    iframe.src = withPreviewQuery(previewUrl, `${baseUrl}${normalizedPath}`);
  };
  const reload = () => {
    const iframe = iframeRef.current;
    if (iframe) iframe.src = iframe.src;
  };
  const history = (dir: "back" | "forward") => {
    try {
      iframeRef.current?.contentWindow?.history[dir]();
    } catch {}
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1" data-preview-controls>
      <button type="button" onClick={() => history("back")} className={iconButton} title="Back" aria-label="Back">
        <ArrowLeftIcon className="size-3.5" />
      </button>
      <button type="button" onClick={() => history("forward")} className={iconButton} title="Forward" aria-label="Forward">
        <ArrowRightIcon className="size-3.5" />
      </button>
      <button type="button" onClick={reload} className={iconButton} title="Reload" aria-label="Reload preview">
        <RotateCwIcon className="size-3.5" />
      </button>
      <form
        className="ml-1 min-w-0 flex-1"
        onSubmit={(e) => {
          e.preventDefault();
          navigate(urlValue);
        }}
      >
        <input
          type="text"
          value={urlValue}
          onChange={(e) => setUrlValue(e.target.value)}
          className="h-7 w-full rounded-md bg-muted/50 px-2.5 text-xs text-foreground transition-colors outline-none focus:bg-muted focus:ring-1 focus:ring-ring"
          aria-label="Preview path"
        />
      </form>
      {showDevices && (
        <div className="ml-1 flex items-center rounded-md border p-0.5" role="group" aria-label="Preview width">
          {(Object.keys(DEVICES) as Device[]).map((d) => {
            const { label, icon: Icon } = DEVICES[d];
            return (
              <button
                key={d}
                type="button"
                onClick={() => onDevice(d)}
                aria-pressed={device === d}
                aria-label={label}
                title={label}
                className={cn("flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground", device === d && "bg-muted text-foreground")}
                data-device={d}
              >
                <Icon className="size-3.5" />
              </button>
            );
          })}
        </div>
      )}
      {/* The preview is the owner's capability URL: opened only in their own browser, never sent elsewhere. */}
      <a href={current} target="_blank" rel="noopener noreferrer" className={iconButton} title="Open preview in a new tab" aria-label="Open preview in a new tab">
        <ExternalLinkIcon className="size-3.5" />
      </a>
    </div>
  );
}
