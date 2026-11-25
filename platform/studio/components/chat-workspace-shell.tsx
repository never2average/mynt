"use client";

// The studio's chat workspace, shared by an app's builder (app/(studio)/[projectId]) and Earn
// (/earn), so both look the same and differ only in the tabs on the right. It's the builder's
// layout, extracted:
// - an optional sticky top bar (the app's own bar in the builder);
// - the chat (thread and composer) on the left, alone (centred) until there's something for
//   the right panel (the builder shows it as soon as an app is open; Earn after the first
//   message, or when a link names a panel tab);
// - the right panel: a tab strip at its top, then the selected tab's content, in the builder's
//   2fr / 3fr split with the same easing;
// - a visible divider between chat and panel, and (desktop) a button to collapse the panel away,
//   remembered per browser; collapsed (or not open yet), Show tabs floats at the chat's top right,
//   beside whatever the page puts there (Earn's Past conversations);
// - on phones, one side at a time, switched by the round button (or the top bar's back control).
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { MessageSquareIcon, PanelRightCloseIcon, PanelRightIcon, PanelRightOpenIcon } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils"
import { Tab, TabList } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// icon: when every tab has one, the collapsed panel shows them as buttons beside the chat's corner.
export type PanelTab = { id: string; label: string; badge?: number; content: ReactNode; icon?: ComponentType };
export type MobileView = "chat" | "panel";
const COLLAPSE_KEY = "mynt.chat-panel.collapsed";

export function PanelTabStrip({ tabs, tab, onTab, header, onCollapse }: { tabs: PanelTab[]; tab: string; onTab: (id: string) => void; header?: ReactNode; onCollapse?: () => void }) {
  return (
    <div className="flex h-10 shrink-0 items-stretch gap-1 px-3 shadow-[inset_0_-1px_0_var(--color-border)]" data-panel-tabs>
      {/* The strip's bottom line is the tab bar's own (an inset shadow): the active tab's underline covers it. */}
      <TabList aria-label="Panel" className="w-auto flex-1">
        {tabs.map((t) => (
          <Tab key={t.id} selected={t.id === tab} data-panel-tab={t.id} onClick={() => onTab(t.id)}>
            {t.label}
            {t.badge ? (
              <span className="rounded-full bg-muted px-1.5 text-xs leading-5 text-foreground tabular-nums" data-badge={t.badge}>
                {t.badge}
              </span>
            ) : null}
          </Tab>
        ))}
      </TabList>
      {header && <div className="ml-auto flex min-w-0 shrink items-center self-center gap-2 text-xs text-muted-foreground">{header}</div>}
      {onCollapse && (
        <button
          type="button"
          onClick={onCollapse}
          className={cn("flex size-7 shrink-0 items-center justify-center self-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none", !header && "ml-auto")}
          title="Collapse tabs"
          aria-label="Collapse tabs"
          data-collapse-panel
        >
          <PanelRightCloseIcon className="size-4" />
        </button>
      )}
    </div>
  );
}

export function ChatWorkspaceShell({
  topBar,
  chat,
  showPanel,
  tabs,
  tab,
  onTab,
  panelHeader,
  mobileView: controlledMobile,
  onMobileView,
  isMobile: forcedMobile,
  chatCorner,
  onOpenPanel,
}: {
  topBar?: ReactNode;
  chat: ReactNode;
  // Floating at the chat's top right (e.g. Past conversations); on desktop, Show tabs sits beside it
  // whenever the panel is collapsed or not open yet (onOpenPanel opens one that isn't).
  chatCorner?: ReactNode;
  onOpenPanel?: () => void;
  showPanel: boolean;
  tabs: PanelTab[];
  tab: string;
  onTab: (id: string) => void;
  panelHeader?: ReactNode;
  mobileView?: MobileView;
  onMobileView?: (v: MobileView) => void;
  isMobile?: boolean; // for the tests; otherwise the viewport decides
}) {
  const detected = useIsMobile();
  const isMobile = forcedMobile ?? detected;
  const [ownMobile, setOwnMobile] = useState<MobileView>("chat");
  const mobileView = controlledMobile ?? ownMobile;
  const setMobileView = onMobileView ?? setOwnMobile;
  const current = tabs.find((t) => t.id === tab) ?? tabs[0];
  // Desktop only: the panel can be collapsed to a slim rail and reopened; remembered per browser.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {}
  }, []);
  const collapse = (v: boolean) => {
    setCollapsed(v);
    try {
      window.localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0");
    } catch {}
  };
  const railed = showPanel && !isMobile && collapsed;

  // Collapsed, the panel takes no room: Show tabs, in the chat's top-right corner, brings it back.
  const gridColumns = !showPanel ? "1fr 0fr" : isMobile ? (mobileView === "chat" ? "1fr 0fr" : "0fr 1fr") : railed ? "1fr 0fr" : "2fr 3fr";
  const canShowTabs = !isMobile && tabs.length > 0 && (railed || (!showPanel && Boolean(onOpenPanel)));
  const showTabs = () => {
    if (railed) collapse(false);
    else onOpenPanel?.();
  };

  return (
    <div
      className="group/chat flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden"
      data-chat-workspace
      data-panel-open={showPanel}
      // The chat (messages, composer, its note) is centred until the tabs panel is open beside it, then sits left.
      data-chat-align={showPanel && !railed && !isMobile ? "left" : "center"}
    >
      {topBar}
      <div
        className={cn("grid min-h-0 flex-1 pb-2", !isMobile && "transition-[grid-template-columns] duration-500 ease-in-out")}
        style={isMobile ? undefined : { gridTemplateColumns: gridColumns }}
      >
        <div className={cn("relative min-w-0 overflow-hidden", isMobile && showPanel && mobileView === "panel" && "hidden")} data-chat-side>
          {chat}
          {(chatCorner || canShowTabs) && (
            <div className="absolute top-3 right-3 z-10 flex items-center gap-2" data-chat-corner>
              {chatCorner}
              {/* Tabs with icons (Earn's): one button per tab, opening the panel on it. Otherwise one Show tabs. */}
              {canShowTabs && tabs.every((t) => t.icon) &&
                tabs.map((t) => {
                  const Icon = t.icon!;
                  return (
                    <Tooltip key={t.id}>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          className="relative rounded-full bg-background"
                          aria-label={`Open ${t.label}`}
                          onClick={() => {
                            onTab(t.id);
                            showTabs();
                          }}
                          data-expand-panel={t.id}
                        >
                          <Icon />
                          {t.badge ? (
                            <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[10px] font-medium text-background tabular-nums" data-tab-badge>
                              {t.badge}
                            </span>
                          ) : null}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{t.label}</TooltipContent>
                    </Tooltip>
                  );
                })}
              {canShowTabs && !tabs.every((t) => t.icon) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" size="icon-sm" className="rounded-full bg-background" aria-label="Show tabs" onClick={showTabs} data-expand-panel>
                      <PanelRightOpenIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Show tabs ({current?.label ?? "panel"})</TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
        </div>
        <div
          className={cn(
            "flex min-w-0 flex-col overflow-hidden",
            // A visible divide between the chat and the tabs.
            !isMobile && showPanel && !railed && "border-l bg-muted/20",
            !isMobile && "transition-opacity duration-500",
            showPanel && (!isMobile || mobileView === "panel") ? "opacity-100" : !isMobile && "pointer-events-none opacity-0",
            isMobile && (mobileView === "chat" || !showPanel) && "hidden",
          )}
          data-panel-side
          data-panel-collapsed={railed}
        >
          {showPanel && current && !railed && (
            <>
              <PanelTabStrip tabs={tabs} tab={current.id} onTab={onTab} header={panelHeader} onCollapse={isMobile ? undefined : () => collapse(true)} />
              {/* Every tab stays mounted (hidden when not selected), so what's typed or confirmed in
                  one isn't lost by looking at another. */}
              {tabs.map((t) => (
                <div key={t.id} className="min-h-0 flex-1 overflow-hidden" role="tabpanel" hidden={t.id !== current.id} data-panel-content={t.id}>
                  {t.content}
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {isMobile && showPanel && (
        <button
          type="button"
          onClick={() => setMobileView(mobileView === "chat" ? "panel" : "chat")}
          className="fixed right-4 bottom-44 z-50 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform active:scale-95"
          title={mobileView === "chat" ? `Show ${current?.label ?? "panel"}` : "Show chat"}
          aria-label={mobileView === "chat" ? `Show ${current?.label ?? "panel"}` : "Show chat"}
          data-mobile-switch
        >
          {mobileView === "chat" ? <PanelRightIcon className="size-5" /> : <MessageSquareIcon className="size-5" />}
        </button>
      )}
    </div>
  );
}
