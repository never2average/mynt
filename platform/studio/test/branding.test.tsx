import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Mynt's branding: the logo, the page metadata and titles, the manifest and icons, the theme's
// contrast, and no Adorable branding left in what users see.

vi.mock("next/font/google", () => {
  const font = (variable: string) => () => ({ variable, className: variable, style: { fontFamily: variable } });
  return { DM_Sans: font("--font-dm-sans"), Space_Grotesk: font("--font-space-grotesk"), Geist_Mono: font("--font-geist-mono") };
});

const root = fileURLToPath(new URL("..", import.meta.url));
const { MyntLogo, MyntMark } = await import("@/components/brand/mynt-logo");
const { BRAND, SITE_DESCRIPTION, SITE_NAME } = await import("@/lib/brand");
const { contrastRatio } = await import("@/lib/contrast");

describe("the logo", () => {
  it("draws the mint mark and the wordmark, coloured for the surface", () => {
    const dark = renderToStaticMarkup(<MyntLogo variant="dark" />);
    expect(dark).toContain(`fill="${BRAND.mint}"`);
    expect(dark).toContain(">mynt</text>");
    expect(dark).toContain(`fill="${BRAND.white}"`);
    expect(dark).toContain('aria-label="Mynt"');

    const light = renderToStaticMarkup(<MyntLogo variant="light" />);
    expect(light).toContain(`fill="${BRAND.forest}"`);
    expect(light).toContain(">mynt</text>");

    expect(renderToStaticMarkup(<MyntLogo />)).toContain('fill="currentColor"');
  });

  it("shows the mark alone for the mark variant, at the size asked", () => {
    const mark = renderToStaticMarkup(<MyntLogo variant="mark" size={16} />);
    expect(mark).toContain(`fill="${BRAND.mint}"`);
    expect(mark).not.toContain("mynt</text>");
    expect(mark).toContain('width="16"');
    expect(mark).toContain('aria-label="Mynt"');
    expect(renderToStaticMarkup(<MyntMark />)).toContain('aria-hidden="true"');
  });

  it("lets the wordmark be hidden on the collapsed sidebar rail", () => {
    const html = renderToStaticMarkup(<MyntLogo wordmarkClassName="group-data-[collapsible=icon]:hidden" />);
    expect(html).toMatch(/<svg[^>]*class="[^"]*group-data-\[collapsible=icon\]:hidden[^"]*"[^>]*data-mynt-wordmark/);
  });
});

describe("metadata", () => {
  it("titles every page '<page> · Mynt Studio', with Mynt's description and theme colours", async () => {
    const { generateMetadata, viewport } = await import("@/app/layout");
    const meta = await generateMetadata();
    expect(meta.title).toEqual({ default: "Mynt Studio", template: "%s · Mynt Studio" });
    expect(meta.description).toBe("Build compliant finance apps with Mynt's coding agent");
    expect(meta.applicationName).toBe(SITE_NAME);
    expect(meta.metadataBase).toBeInstanceOf(URL);
    expect(viewport.themeColor).toEqual([
      { media: "(prefers-color-scheme: light)", color: "#F2F6F3" },
      { media: "(prefers-color-scheme: dark)", color: "#0F2A23" },
    ]);
  });

  it("names each studio page in its tab title", async () => {
    const studio = await import("@/app/(studio)/layout");
    expect(studio.metadata.title).toEqual({ default: "Dashboard · Mynt Studio", template: "%s · Mynt Studio" });
    const titles: Record<string, unknown> = {
      Audits: (await import("@/app/(studio)/audits/layout")).metadata.title,
      Earn: (await import("@/app/(studio)/earn/layout")).metadata.title,
      "New app": (await import("@/app/(studio)/new/layout")).metadata.title,
      Builds: (await import("@/app/(studio)/builds/layout")).metadata.title,
      Licences: (await import("@/app/(studio)/licences/page")).metadata.title,
      Settings: (await import("@/app/(studio)/settings/page")).metadata.title,
      "Signed out": (await import("@/app/signed-out/page")).metadata.title,
      "Sign-in failed": (await import("@/app/signin-error/page")).metadata.title,
    };
    for (const [want, got] of Object.entries(titles)) expect(got, want).toBe(want);
  }, 30_000); // the pages' imports take a while on a cold start

  it("titles an app's pages with its name, else 'App'", async () => {
    const { appNameIn } = await import("@/lib/conversation");
    const apps = [{ id: "a1", name: " Round-up savings " }, { id: "a2", name: "" }];
    expect(appNameIn(apps, "a1")).toBe("Round-up savings");
    expect(appNameIn(apps, "a2")).toBe("App");
    expect(appNameIn(apps, "nope")).toBe("App");
    expect(appNameIn({ error: "x" }, "a1")).toBe("App");
  });
});

describe("manifest and icons", () => {
  it("names the studio and uses the brand colours and icons", async () => {
    const { default: manifest } = await import("@/app/manifest");
    const m = manifest();
    expect(m.name).toBe("Mynt Studio");
    expect(m.short_name).toBe("Mynt");
    expect(m.description).toBe(SITE_DESCRIPTION);
    expect(m.theme_color).toBe("#0F2A23");
    expect(m.background_color).toBe("#0F2A23");
    expect(m.icons?.map((i) => i.src)).toEqual(["/icon", "/apple-icon"]);
  });

  it("has the tab icon (a mint circle), the home-screen icon and the share image", async () => {
    const icon = await import("@/app/icon");
    expect(icon.size).toEqual({ width: 32, height: 32 });
    expect(icon.contentType).toBe("image/png");
    expect(readFileSync(join(root, "app/icon.tsx"), "utf8")).toContain("background: BRAND.mint");
    expect(existsSync(join(root, "app/favicon.ico"))).toBe(false); // no stray default icon

    const apple = await import("@/app/apple-icon");
    expect(apple.size).toEqual({ width: 180, height: 180 });
    expect(apple.contentType).toBe("image/png");
    const og = await import("@/app/opengraph-image");
    expect(og.size).toEqual({ width: 1200, height: 630 });
    expect(og.contentType).toBe("image/png");
    expect(og.alt).toBe("Mynt Studio: Build compliant finance apps with an AI agent");
  });

  it("serves the icons and manifest without a sign-in", async () => {
    const { pageNeedsSignIn } = await import("@/lib/page-gate");
    for (const p of ["/icon", "/apple-icon", "/opengraph-image", "/opengraph-image-1a2b3c", "/manifest.webmanifest"]) expect(pageNeedsSignIn(p), p).toBe(false);
    for (const p of ["/icons", "/icon.svg/x", "/apple-icon/../settings", "/manifest"]) expect(pageNeedsSignIn(p), p).toBe(true);
  });
});

describe("the theme", () => {
  const css = readFileSync(join(root, "app/globals.css"), "utf8");
  const block = (selector: string) => {
    const body = new RegExp(`^${selector.replace(".", "\\.")} \\{([^}]*)\\}`, "m").exec(css)?.[1] ?? "";
    return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  };
  const themes = { light: block(":root"), dark: block(".dark") };

  const TEXT: [string, string][] = [
    ["foreground", "background"],
    ["card-foreground", "card"],
    ["popover-foreground", "popover"],
    ["primary-foreground", "primary"],
    ["secondary-foreground", "secondary"],
    ["accent-foreground", "accent"],
    ["muted-foreground", "background"],
    ["muted-foreground", "muted"],
    ["muted-foreground", "card"],
    ["sidebar-foreground", "sidebar"],
    ["sidebar-primary-foreground", "sidebar-primary"],
    ["sidebar-accent-foreground", "sidebar-accent"],
  ];

  for (const [name, vars] of Object.entries(themes)) {
    it(`${name}: text pairs meet WCAG AA (4.5:1) and the focus ring 3:1`, () => {
      for (const [fg, bg] of TEXT) expect(contrastRatio(vars[fg], vars[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(vars.ring, vars.background), "ring on background").toBeGreaterThanOrEqual(3);
    });
  }

  it("maps the brand: mint primary with dark green text, deep green dark sidebar, brand greens first in charts", () => {
    for (const vars of Object.values(themes)) {
      expect(vars.primary.toLowerCase()).toBe(BRAND.mint.toLowerCase());
      expect(vars["primary-foreground"].toLowerCase()).toBe(BRAND.forest.toLowerCase());
    }
    expect(themes.dark.background.toLowerCase()).toBe(BRAND.forest.toLowerCase());
    expect(themes.dark.card.toLowerCase()).toBe(BRAND.panel.toLowerCase());
    expect(themes.light.background.toLowerCase()).toBe(BRAND.light.toLowerCase());
    expect(themes.light.foreground.toLowerCase()).toBe(BRAND.ink.toLowerCase());
    expect(themes.dark.sidebar.toLowerCase()).toMatch(/^#0[a-f0-9]2[a-f0-9]{3}$/); // a deep green
    expect(themes.dark["chart-1"].toLowerCase()).toBe(BRAND.mint.toLowerCase());
    expect(themes.light["chart-1"].toLowerCase()).toBe(BRAND.deepGreen.toLowerCase());
    // Semantic colours stay: destructive red, the coverage map's blues.
    expect(themes.light.destructive).toMatch(/^oklch\(0\.577 0\.245 27/);
    expect(themes.dark["coverage-unlocked"]).toBe("#5aa5f5");
  });

  it("measures contrast as WCAG does", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#3DDC97", "#3DDC97")).toBe(1);
    expect(() => contrastRatio("mint", "#fff")).toThrow();
  });
});

describe("no Adorable branding in the UI", () => {
  // Every .ts/.tsx file under app/, components/ and lib/, with comments taken out. The browser
  // events still named "adorable:*" are internal, never shown.
  const files = (dir: string): string[] =>
    readdirSync(join(root, dir)).flatMap((f) => {
      const rel = join(dir, f);
      return statSync(join(root, rel)).isDirectory() ? files(rel) : /\.(tsx?|svg|css)$/.test(f) ? [rel] : [];
    });

  it("has no 'Adorable' outside comments", () => {
    const hits: string[] = [];
    for (const f of ["app", "components", "lib"].flatMap(files)) {
      const code = readFileSync(join(root, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      if (/Adorable/.test(code)) hits.push(f);
    }
    expect(hits).toEqual([]);
  });
});
