import type { Metadata } from "next";

// The tab title for this page (the page itself runs in the browser, so it can't set it).
export const metadata: Metadata = { title: "New app" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
