"use client";

// Settings → E-signature (/settings?tab=esign), for Mynt admins: the Settings tabs, then the e-signature section
// (components/esign-settings-view.tsx). The workspace's tabs go back to their own pages.
import { EsignSettingsPanel } from "@/components/esign-settings-view";
import { TabSelector } from "@/components/workspace-view";

export function EsignSettingsPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="@container/main flex min-h-0 w-full flex-1 flex-col gap-4 p-4 lg:gap-5 lg:p-6">
        <TabSelector tab="esign" esign onTab={(t) => window.location.assign(`/settings?tab=${t}`)} />
        <EsignSettingsPanel />
      </div>
    </div>
  );
}
