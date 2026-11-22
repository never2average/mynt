"use client";

// An app's top bar, in place of the page header inside an app, as Adorable's workspace top bar
// lays it out (back to the app's builds or all apps, then the preview's browser controls) with
// what Lovable-style builders add: the app's name and stage, the preview's width (desktop,
// tablet, phone) and opening the preview in a new tab, each icon with a tooltip. The bar matches the
// page header (SiteHeader): its height, padding and title. A labelled Back; Search and New app stay at
// the right, labelled as in the page header (icons below md), with the GitHub and wallet controls
// (hidden on phones) beside New app, and the theme switcher last. Sticky. Beside the stage is the stage control: Promote to Staging or Production
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
import { GithubControl } from "@/components/github-control";
import { DeveloperOnly } from "@/components/studio-gates";
import { ConnectAgentButton } from "@/components/connect-agent";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { WalletControl } from "@/components/wallet-control";
import { NewAppButton } from "@/components/site-header";
import { SearchTrigger } from "@/components/studio-search";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
    <header className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background px-4 lg:px-6" data-app-top-bar>
      <SidebarTrigger />
      <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" data-toggle-separator />
      {isMobile && mobileView === "preview" ? (
        <Button type="button" variant="ghost" size="sm" onClick={onShowChat} className="shrink-0 px-2 text-muted-foreground" data-show-chat>
          <ChevronLeftIcon />
          Chat
        </Button>
      ) : (
        <Button type="button" variant="ghost" size="sm" onClick={onBack} title={`Back to ${backLabel.toLowerCase()}`} aria-label={`Back to ${backLabel.toLowerCase()}`} className="shrink-0 px-2 text-muted-foreground" data-app-back>
          <ChevronLeftIcon />
          Back
        </Button>
      )}
      {/* The app's name gives up room first; nothing here ever runs under the controls on the right. */}
      <div className="flex min-w-0 items-center gap-2 overflow-hidden pr-2" data-app-title>
        <h1 className="truncate text-base font-medium" data-app-name>
          {appName ?? "Loading app…"}
        </h1>
        {stage && (
          // On a phone the sidebar's folders say the stage; the name needs the room.
          <Badge variant="outline" className="hidden shrink-0 font-normal sm:inline-flex" data-app-stage={stage}>
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

      {/* As the page header has them: labelled Search and New app where there's room, icons below md. */}
      <div className="flex shrink-0 items-center gap-2">
        <span className="flex md:hidden">
          <SearchTrigger compact />
        </span>
        <span className="hidden md:flex">
          <SearchTrigger className="md:w-40 lg:w-48 xl:w-64" />
        </span>
        <DeveloperOnly>
          {!isMobile && <GithubControl />}
          {!isMobile && <WalletControl compact />}
          <span className="flex md:hidden">
            <NewAppButton compact />
          </span>
          <span className="hidden md:flex">
            <NewAppButton />
          </span>
        </DeveloperOnly>
        <ConnectAgentButton />
        <ThemeSwitcher compact />
      </div>
    </header>
  );
}

/** An icon-only preview control's visible tooltip (its aria-label names it too). */
function Tip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
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
      <Tip label="Back in preview">
        <button type="button" onClick={() => history("back")} className={iconButton} aria-label="Back in preview">
          <ArrowLeftIcon className="size-3.5" />
        </button>
      </Tip>
      <Tip label="Forward in preview">
        <button type="button" onClick={() => history("forward")} className={iconButton} aria-label="Forward in preview">
          <ArrowRightIcon className="size-3.5" />
        </button>
      </Tip>
      <Tip label="Reload preview">
        <button type="button" onClick={reload} className={iconButton} aria-label="Reload preview">
          <RotateCwIcon className="size-3.5" />
        </button>
      </Tip>
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
              <Tip key={d} label={`${label} width`}>
                <button
                  type="button"
                  onClick={() => onDevice(d)}
                  aria-pressed={device === d}
                  aria-label={label}
                  className={cn("flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground", device === d && "bg-muted text-foreground")}
                  data-device={d}
                >
                  <Icon className="size-3.5" />
                </button>
              </Tip>
            );
          })}
        </div>
      )}
      {/* The preview is the owner's capability URL: opened only in their own browser, never sent elsewhere. */}
      <Tip label="Open preview in a new tab">
        <a href={current} target="_blank" rel="noopener noreferrer" className={iconButton} aria-label="Open preview in a new tab">
          <ExternalLinkIcon className="size-3.5" />
        </a>
      </Tip>
    </div>
  );
}
