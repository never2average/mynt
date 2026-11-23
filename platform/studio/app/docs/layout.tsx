import type { Metadata } from "next";

import { DocsFrame } from "@/components/docs/docs-frame";
import { SHORT_NAME } from "@/lib/brand";

// Mynt's docs (/docs, and Connect your agent at /connect): public, outside the signed-in studio shell
// (lib/page-gate.ts opens them), laid out by Fumadocs UI (components/docs/docs-frame.tsx).
export const metadata: Metadata = {
  title: { default: `Docs · ${SHORT_NAME}`, template: `%s · ${SHORT_NAME} Docs` },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <DocsFrame>{children}</DocsFrame>;
}
