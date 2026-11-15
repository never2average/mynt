import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// The studio's branding: the page metadata and titles, the manifest and icons (the app icon's
// mint circle is the only brand mark), the neutral theme with mint as its accent and its
// contrast, and no Adorable branding left in what users see.

vi.mock("next/font/google", () => {
  const font = (variable: string) => () => ({ variable, className: variable, style: { fontFamily: variable } });
  return { DM_Sans: font("--font-dm-sans"), Space_Grotesk: font("--font-space-grotesk"), Geist_Mono: font("--font-geist-mono") };
});

const root = fileURLToPath(new URL("..", import.meta.url));
const { BRAND, SITE_DESCRIPTION, SITE_NAME } = await import("@/lib/brand");
const { contrastRatio } = await import("@/lib/contrast");

describe("metadata", () => {
  it("titles every page '<page> · Mynt Studio', with Mynt's description and theme colours", async () => {
    const { generateMetadata, viewport } = await import("@/app/layout");
    const meta = await generateMetadata();
    expect(meta.title).toEqual({ default: "Mynt Studio", template: "%s · Mynt Studio" });
    expect(meta.description).toBe("Build compliant finance apps with Mynt's coding agent");
    expect(meta.applicationName).toBe(SITE_NAME);
    expect(meta.metadataBase).toBeInstanceOf(URL);
    expect(viewport.themeColor).toEqual([
      { media: "(prefers-color-scheme: light)", color: "#FFFFFF" },
      { media: "(prefers-color-scheme: dark)", color: "#09090B" },
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
    expect(m.theme_color).toBe("#09090B");
    expect(m.background_color).toBe("#09090B");
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
      expect(contrastRatio(vars.link, vars.background), "link on background").toBeGreaterThanOrEqual(4.5);
    });
  }

  // Whether a #rrggbb colour is a neutral grey (its channels within a few steps of each other).
  const rgb = (hex: string) => {
    const n = Number.parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const neutral = (hex: string) => Math.max(...rgb(hex)) - Math.min(...rgb(hex)) <= 10;
  const hexes = (vars: Record<string, string>) => Object.entries(vars).filter(([, v]) => /^#[0-9a-f]{6}$/i.test(v));

  it("is shadcn's neutral palette: neutral surfaces, text, borders and sidebar", () => {
    for (const [name, vars] of Object.entries(themes)) {
      for (const k of ["background", "foreground", "card", "popover", "secondary", "muted", "muted-foreground", "accent", "sidebar", "sidebar-accent"]) {
        expect(neutral(vars[k]), `${name} ${k} ${vars[k]}`).toBe(true);
      }
    }
    expect(neutral(themes.light.border)).toBe(true);
    expect(themes.dark.background).toBe("#09090b");
    expect(themes.light.background).toBe("#ffffff");
  });

  it("uses the app icon's mint only as the accent: primary, ring, links and the first chart colour", () => {
    const mint = BRAND.mint.toLowerCase();
    for (const vars of Object.values(themes)) {
      expect(vars.primary).toBe(mint);
      expect(vars["sidebar-primary"]).toBe(mint);
      expect(neutral(vars["primary-foreground"])).toBe(true); // near-black text on mint
    }
    expect(themes.dark.ring).toBe(mint);
    expect(themes.dark["sidebar-ring"]).toBe(mint);
    expect(themes.light.ring).toBe(BRAND.deepMint.toLowerCase()); // mint is too light to see on white
    expect(themes.light.link).toBe(BRAND.deepMint.toLowerCase());
    expect(themes.dark.link).toBe(mint);
    expect(themes.dark["chart-1"]).toBe(mint);
    // Mint appears nowhere else.
    const accents = new Set(["primary", "sidebar-primary", "ring", "sidebar-ring", "link", "chart-1"]);
    for (const vars of Object.values(themes)) {
      for (const [k, v] of hexes(vars)) if (!accents.has(k)) expect(v, k).not.toBe(mint);
    }
    // The other chart colours aren't greens.
    for (const vars of Object.values(themes)) {
      for (const k of ["chart-2", "chart-3", "chart-4", "chart-5"]) {
        const [r, g, b] = rgb(vars[k]);
        expect(g > r + 10 && g > b + 10, `${k} ${vars[k]} is green`).toBe(false);
      }
    }
    // The active sidebar row has no accent: no rule styles it in the theme, and its shadcn classes
    // are the neutral sidebar-accent (a zinc grey in both themes), never primary or mint.
    expect(css).not.toMatch(/data-active/);
    for (const vars of Object.values(themes)) expect(neutral(vars["sidebar-accent"])).toBe(true);
    const sidebar = readFileSync(join(root, "components/ui/sidebar.tsx"), "utf8");
    const active = [...sidebar.matchAll(/data-\[active=true\]:([\w-]+)/g)].map((m) => m[1]);
    expect(new Set(active)).toEqual(new Set(["bg-sidebar-accent", "text-sidebar-accent-foreground", "font-medium"]));
    expect(sidebar).not.toMatch(/data-\[active=true\]:[\w-]*(primary|ring|mint)/);
    // Text in the accent colour uses the link token, never mint on white.
    for (const f of ["components/ask-ai-markdown.tsx", "components/ui/button.tsx", "components/studio-search.tsx", "components/ask-ai.tsx"])
      expect(readFileSync(join(root, f), "utf8"), f).not.toMatch(/\btext-primary\b(?!-)/);
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

describe("no logo in the UI", () => {
  it("has no wordmark or logo component: the app icon is the only brand mark", () => {
    expect(existsSync(join(root, "components/brand"))).toBe(false);
    for (const f of ["components/app-sidebar.tsx", "components/chat-welcome.tsx", "components/ask-ai.tsx", "app/signed-out/page.tsx", "app/signin-error/page.tsx", "app/opengraph-image.tsx"]) {
      const code = readFileSync(join(root, f), "utf8");
      expect(code, f).not.toMatch(/MyntLogo|MyntMark|>mynt</);
    }
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
