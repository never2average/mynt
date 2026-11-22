import type { Metadata } from "next";

import { DocsShell } from "@/components/docs/docs-shell";
import { SHORT_NAME } from "@/lib/brand";
import { docsNav } from "@/lib/docs";

// Mynt's docs (/docs): public, outside the signed-in studio shell (lib/page-gate.ts opens /docs and everything under
// it). The pages and the tool reference come from core's generated data (lib/docs.ts).
export const metadata: Metadata = {
  title: { default: `Docs · ${SHORT_NAME}`, template: `%s · ${SHORT_NAME} Docs` },
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <DocsShell nav={docsNav()}>{children}</DocsShell>;
}
