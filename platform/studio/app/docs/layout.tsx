import type { Metadata } from "next";

import { DocsShell } from "@/components/docs/docs-frame";
import { SHORT_NAME } from "@/lib/brand";
import { currentSession } from "@/lib/session";

// Mynt's docs (/docs, and Connect your agent at /connect): public (lib/page-gate.ts opens them), laid out by Fumadocs
// UI (components/docs/docs-frame.tsx). A signed-in visitor (a session with tokens, as proxy.ts checks it) reads them
// inside the studio's shell; anyone else gets the standalone public layout.
export const metadata: Metadata = {
  title: { default: `Docs · ${SHORT_NAME}`, template: `%s · ${SHORT_NAME} Docs` },
};

export default async function Layout({ children }: { children: React.ReactNode }) {
  const session = await currentSession().catch(() => undefined);
  return <DocsShell signedIn={Boolean(session?.tokens)}>{children}</DocsShell>;
}
