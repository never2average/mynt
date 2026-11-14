import type { Metadata } from "next";

import { SITE_NAME, TITLE_TEMPLATE } from "@/lib/brand";
import { StudioShell } from "./studio-shell";

// Every signed-in page, in the studio's shell (./studio-shell.tsx). The tab title is the page's
// name (each page sets it), and the dashboard's when a page doesn't.
export const metadata: Metadata = {
  title: { default: `Dashboard · ${SITE_NAME}`, template: TITLE_TEMPLATE },
};

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return <StudioShell>{children}</StudioShell>;
}
