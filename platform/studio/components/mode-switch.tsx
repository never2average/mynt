"use client"

// The dashboard's Builder / Investor views: the studio's line tabs (components/ui/tabs.tsx), in
// the page header beside the title like other pages' tabs, shown only when the user's roles
// allow both views.
import { Tab, TabList } from "@/components/ui/tabs"
import { MODE_LABELS, type DashboardMode } from "@/lib/investor"

export function ModeSwitch({ modes, mode, onMode }: { modes: DashboardMode[]; mode: DashboardMode; onMode: (m: DashboardMode) => void }) {
  if (modes.length < 2) return null
  return (
    // The header's own bottom border carries the underline.
    <TabList aria-label="Dashboard view" className="h-full items-stretch border-b-0" data-mode-switch>
      {modes.map((m) => (
        <Tab key={m} selected={m === mode} onClick={() => onMode(m)} data-mode={m}>
          {MODE_LABELS[m]}
        </Tab>
      ))}
    </TabList>
  )
}
