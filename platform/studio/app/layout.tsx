import type { Metadata, Viewport } from "next";
import { DM_Sans, Geist_Mono, Space_Grotesk } from "next/font/google";
import { headers } from "next/headers";
import { ThemeProvider } from "@/components/theme-switcher";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BRAND, SITE_DESCRIPTION, SITE_NAME, TITLE_TEMPLATE } from "@/lib/brand";
import { appUrl } from "@/lib/config";
import "./globals.css";

// Mynt's type: headings in Space Grotesk, body in DM Sans. next/font downloads them when the
// studio is built and serves them itself, so pages make no font request elsewhere (the CSP's
// font-src stays 'self').
const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Rendered per request, so each page carries that request's CSP nonce (proxy.ts).
export const dynamic = "force-dynamic";

// The icons, the share image and the manifest come from the files beside this one (icon.tsx,
// apple-icon.tsx, opengraph-image.tsx, manifest.ts); Next links them on every page.
export async function generateMetadata(): Promise<Metadata> {
  return {
    metadataBase: appUrl(),
    title: { default: SITE_NAME, template: TITLE_TEMPLATE },
    description: SITE_DESCRIPTION,
    applicationName: SITE_NAME,
    openGraph: { siteName: SITE_NAME, title: SITE_NAME, description: SITE_DESCRIPTION, type: "website" },
    twitter: { card: "summary_large_image", title: SITE_NAME, description: SITE_DESCRIPTION },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: BRAND.light },
    { media: "(prefers-color-scheme: dark)", color: BRAND.dark },
  ],
};

// The theme is light, dark or the system's (components/theme-switcher.tsx): next-themes sets the
// class on <html> before the page paints, so <html> carries no theme class of its own and React
// is told the class may differ from the server's (suppressHydrationWarning). Its inline script
// carries this request's CSP nonce (proxy.ts sets x-nonce).
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" className="h-full overflow-hidden" suppressHydrationWarning>
      <body
        className={`${dmSans.variable} ${spaceGrotesk.variable} ${geistMono.variable} h-full overflow-hidden overscroll-none font-sans antialiased`}
      >
        {/* Every page but /signin-error and /signed-out needs a signed-in user; proxy.ts sends
            anyone else straight to sign-in. */}
        <ThemeProvider nonce={nonce}>
          <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
