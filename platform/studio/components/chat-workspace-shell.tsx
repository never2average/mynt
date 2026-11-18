"use client";

// The studio's chat workspace, shared by an app's builder (app/(studio)/[projectId]) and Earn
// (/earn), so both look the same and differ only in the tabs on the right. It's the builder's
// layout, extracted:
// - an optional sticky top bar (the app's own bar in the builder);
// - the chat (thread and composer) on the left, alone (left-aligned) until there's something for
//   the right panel (the builder shows it as soon as an app is open; Earn after the first
//   message, or when a link names a panel tab);
// - the right panel: a tab strip at its top, then the selected tab's content, in the builder's
//   2fr / 3fr split with the same easing;
// - a visible divider between chat and panel, and (desktop) a button to collapse the panel to a
//   slim rail and back, remembered per browser;
// - on phones, one side at a time, switched by the round button (or the top bar's back control).
import { useEffect, useState, type ReactNode } from "react";
import { MessageSquareIcon, PanelRightCloseIcon, PanelRightIcon, PanelRightOpenIcon } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils"
import { Tab, TabList } from "@/components/ui/tabs";

export type PanelTab = { id: string; label: string; badge?: number; content: ReactNode };
export type MobileView = "chat" | "panel";
const COLLAPSE_KEY = "mynt.chat-panel.collapsed";

export function PanelTabStrip({ tabs, tab, onTab, header, onCollapse }: { tabs: PanelTab[]; tab: string; onTab: (id: string) => void; header?: ReactNode; onCollapse?: () => void }) {
  return (
    <div className="flex h-10 shrink-0 items-stretch gap-1 border-b px-3" data-panel-tabs>
      {/* The line tabs' underline sits on this strip's bottom border. */}
      <TabList aria-label="Panel" className="border-b-0">
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
}: {
  topBar?: ReactNode;
  chat: ReactNode;
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

  const gridColumns = !showPanel ? "1fr 0fr" : isMobile ? (mobileView === "chat" ? "1fr 0fr" : "0fr 1fr") : railed ? "1fr 2.75rem" : "2fr 3fr";

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden" data-chat-workspace data-panel-open={showPanel}>
      {topBar}
      <div
        className={cn("grid min-h-0 flex-1 pb-2", !isMobile && "transition-[grid-template-columns] duration-500 ease-in-out")}
        style={isMobile ? undefined : { gridTemplateColumns: gridColumns }}
      >
        <div className={cn("relative min-w-0 overflow-hidden", isMobile && showPanel && mobileView === "panel" && "hidden")} data-chat-side>
          {chat}
        </div>
        <div
          className={cn(
            "flex min-w-0 flex-col overflow-hidden",
            // A visible divide between the chat and the tabs.
            !isMobile && showPanel && "border-l bg-muted/20",
            !isMobile && "transition-opacity duration-500",
            showPanel && (!isMobile || mobileView === "panel") ? "opacity-100" : !isMobile && "pointer-events-none opacity-0",
            isMobile && (mobileView === "chat" || !showPanel) && "hidden",
          )}
          data-panel-side
          data-panel-collapsed={railed}
        >
          {railed && (
            <div className="flex h-full flex-col items-center pt-2" data-panel-rail>
              <button
                type="button"
                onClick={() => collapse(false)}
                className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
                title={`Show tabs (${current?.label ?? "panel"})`}
                aria-label="Show tabs"
                data-expand-panel
              >
                <PanelRightOpenIcon className="size-4" />
              </button>
            </div>
          )}
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
          className="fixed right-4 bottom-20 z-50 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform active:scale-95"
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
