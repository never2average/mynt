import type { Metadata } from "next";

import { DocsPage } from "@/components/docs/docs-page";
import { docsRoute } from "@/lib/docs";

export const metadata: Metadata = { title: "What Mynt is" };

export default function DocsHome() {
  return <DocsPage route={docsRoute([])!} />;
}
