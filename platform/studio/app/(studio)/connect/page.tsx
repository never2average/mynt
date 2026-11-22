"use client";

// Connect your agent (/connect, from the header's plug button beside the theme switcher): using Mynt from your own
// AI agent over MCP. The guide (components/connect-guide.tsx, also the docs' Connect your agent page at
// /docs/connect) in the dashboard's page frame, with On this page on the right; the header names the page.
import { useRef } from "react";

import { ConnectGuide } from "@/components/connect-guide";
import { CONNECT_SECTIONS } from "@/lib/connect-sections";
import { OnThisPage, useScrollSpy } from "@/components/docs/on-this-page";

export default function ConnectPage() {
  // The page scrolls in its own box (the studio shell fixes the window; every long page scrolls itself).
  const scroller = useRef<HTMLDivElement>(null);
  const active = useScrollSpy(CONNECT_SECTIONS, scroller);

  return (
    <div ref={scroller} className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-connect-scroll>
      <div className="flex w-full gap-10 p-4 lg:p-6" data-connect-page data-docs>
        <article className="flex min-w-0 flex-1 flex-col gap-4 lg:gap-5">
          <OnThisPage items={CONNECT_SECTIONS} active={active} row className="-mx-2 flex gap-1 overflow-x-auto pb-1 text-sm md:hidden" />
          <ConnectGuide />
        </article>

        {/* On this page: on the right, set off by a vertical rule. */}
        <OnThisPage items={CONNECT_SECTIONS} active={active} className="sticky top-6 hidden h-fit w-52 shrink-0 space-y-1 border-l pl-6 text-sm md:block" />
      </div>
    </div>
  );
}
