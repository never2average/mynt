import type { Metadata } from "next";

// The tab title for this page (the page itself runs in the browser, so it can't set it).
export const metadata: Metadata = { title: "Audits" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
