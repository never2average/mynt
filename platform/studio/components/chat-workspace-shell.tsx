"use client";

// The studio's chat workspace, shared by an app's builder (app/(studio)/[projectId]) and Earn
// (/earn), so both look the same and differ only in the tabs on the right. It's the builder's
// layout, extracted:
// - an optional sticky top bar (the app's own bar in the builder);
// - the chat (thread and composer) on the left, alone and centred until there's something for
//   the right panel (the builder shows it as soon as an app is open; Earn after the first
//   message, or when a link names a panel tab);
// - the right panel: a tab strip at its top, then the selected tab's content, in the builder's
//   2fr / 3fr split with the same easing;
// - on phones, one side at a time, switched by the round button (or the top bar's back control).
import { useState, type ReactNode } from "react";
import { MessageSquareIcon, PanelRightIcon } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

export type PanelTab = { id: string; label: string; badge?: number; content: ReactNode };
export type MobileView = "chat" | "panel";

export function PanelTabStrip({ tabs, tab, onTab, header }: { tabs: PanelTab[]; tab: string; onTab: (id: string) => void; header?: ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b bg-muted/20 px-2" data-panel-tabs>
      <div role="tablist" aria-label="Panel" className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === tab}
            data-panel-tab={t.id}
            onClick={() => onTab(t.id)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium transition-colors",
              t.id === tab ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            {t.badge ? (
              <span className="rounded-full bg-primary px-1.5 text-xs leading-5 text-primary-foreground tabular-nums" data-badge={t.badge}>
                {t.badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {header && <div className="ml-auto flex min-w-0 shrink items-center gap-2 text-xs text-muted-foreground">{header}</div>}
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

  const gridColumns = !showPanel ? "1fr 0fr" : isMobile ? (mobileView === "chat" ? "1fr 0fr" : "0fr 1fr") : "2fr 3fr";

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
            !isMobile && "transition-opacity duration-500",
            showPanel && (!isMobile || mobileView === "panel") ? "opacity-100" : !isMobile && "pointer-events-none opacity-0",
            isMobile && (mobileView === "chat" || !showPanel) && "hidden",
          )}
          data-panel-side
        >
          {showPanel && current && (
            <>
              <PanelTabStrip tabs={tabs} tab={current.id} onTab={onTab} header={panelHeader} />
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
