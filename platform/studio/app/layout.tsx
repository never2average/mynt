import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Rendered per request, so each page carries that request's CSP nonce (proxy.ts).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Mynt Studio",
  description: "Build apps on Mynt with Mynt's coding agent",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark h-full overflow-hidden">
      <body
        className={`${geistSans.variable} ${geistMono.variable} h-full overflow-hidden overscroll-none antialiased`}
      >
        {/* Every page but /signin-error and /signed-out needs a signed-in user; proxy.ts sends
            anyone else straight to sign-in. */}
        <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
      </body>
    </html>
  );
}
