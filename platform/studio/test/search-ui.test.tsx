// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

// The search: the header's search box, the Cmd+K bar and the Ask AI dialog (components/search-input.tsx,
// components/kbar). Its markup and class strings are pinned here, so a later edit can't drift from the design it was
// built to; then what it lists and asks, in Studio and in the platform admin.

const nav = { pushed: [] as string[] };
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: (href: string) => void nav.pushed.push(href), replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const { useMatches } = await import("kbar");
const { default: KBar, KBarFooter } = await import("@/components/kbar");
const { default: SearchInput } = await import("@/components/search-input");
const { default: ResultItem } = await import("@/components/kbar/result-item");
const { AskAiDialog, AskAiProvider, applyEvent, askAction, historyOf, PANEL_SIZE, stepsLine, useAskAi } = await import("@/components/kbar/ask-ai");
const { CITE, CITE_TIP } = await import("@/components/kbar/markdown");
const { searchActions, BROWSE_IDS } = await import("@/components/kbar/actions");
const { WorkspaceProvider } = await import("@/components/workspace-context");
const { resetStudioAccess } = await import("@/lib/use-liquidity-access");
const { platformSearchIndex, searchIndex } = await import("@/lib/studio-search");

beforeAll(() => {
  // What jsdom lacks and Radix / kbar use.
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
  Element.prototype.animate ??= (() => ({ finished: Promise.resolve(), cancel() {}, onfinish: null })) as unknown as typeof Element.prototype.animate;
});
beforeEach(() => {
  nav.pushed = [];
  resetStudioAccess();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const WS = "44444444-4444-4444-8444-444444444444";
const FIRM = "33333333-3333-4333-8333-333333333333";
const classOf = (el: Element | null | undefined) => el?.getAttribute("class") ?? null;

// ---------- the pinned look ----------

const BUTTON_BASE =
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";
const BUTTON_OUTLINE =
  "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground dark:bg-input/30 dark:hover:bg-input/50 dark:aria-[current=page]:bg-input/60";
const KBD =
  "pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-sm bg-muted px-1 font-sans text-xs font-medium text-muted-foreground select-none in-data-[slot=tooltip-content]:bg-background/20 in-data-[slot=tooltip-content]:text-background dark:in-data-[slot=tooltip-content]:bg-background/10 [&_svg:not([class*='size-'])]:size-3";
const ROW = "relative mx-1.5 flex cursor-pointer items-center justify-between rounded-lg px-2.5 py-2.5 text-sm";

// Each file's class strings, exactly as written in it.
const PINNED: Record<string, string[]> = {
  "components/search-input.tsx": [
    "'h-11 min-w-11 rounded-[0.5rem] px-0 text-sm shadow-none md:h-9 md:min-w-9'",
    "'md:hidden'",
    "'bg-background text-muted-foreground relative hidden justify-start font-normal sm:pr-12 md:flex md:w-40 md:px-3 lg:w-64'",
    "<IconSearch className='h-4 w-4' />",
    "<IconSearch className='mr-2 h-4 w-4' />",
    "Search...",
    "<kbd className='bg-muted pointer-events-none absolute top-[0.3rem] right-[0.3rem] hidden h-6 items-center gap-1 rounded border px-1.5 font-mono text-[10px] font-medium opacity-100 select-none sm:flex'>",
    "<span className='text-xs'>⌘</span>K",
  ],
  "components/kbar/index.tsx": [
    "bg-black/10 supports-backdrop-filter:backdrop-blur-xs fixed inset-0 z-99999 flex items-start! justify-center p-4! pt-[14vh]!",
    "<KBarAnimator className='bg-popover text-popover-foreground ring-foreground/10 relative mx-auto w-full max-w-[600px] overflow-hidden rounded-xl shadow-lg ring-1'>",
    "<div className='bg-popover sticky top-0 z-10 border-b'>",
    "<KBarSearch className='placeholder:text-muted-foreground w-full border-none bg-transparent px-4 py-3.5 text-sm outline-hidden focus:ring-0 focus:outline-hidden' />",
    "<div className='h-[400px]'>",
    "<div className='text-muted-foreground flex items-center gap-3 border-t px-3 py-2 text-xs'>",
    "<span className='flex items-center gap-1'>",
  ],
  "components/kbar/render-result.tsx": [
    "<div className='text-muted-foreground flex h-full items-center justify-center px-4 text-center text-sm'>",
    "No results found.",
    "<div className='text-muted-foreground px-4 pt-3 pb-1 text-xs font-medium tracking-wider uppercase'>",
  ],
  "components/kbar/result-item.tsx": [
    `'${ROW}'`,
    "active && 'bg-accent text-accent-foreground'",
    "<div className='flex items-center gap-2'>",
    "<div className='flex flex-col'>",
    "<span className='text-muted-foreground mr-2'>{ancestor.name}</span>",
    "<span className='mr-2'>&rsaquo;</span>",
    "<span className='text-muted-foreground text-xs'>{action.subtitle}</span>",
    "<div className='grid grid-flow-col gap-1'>",
  ],
  "components/kbar/ask-ai.tsx": [
    "icon: <IconSparkles className='text-primary size-4' />",
    "export const PANEL_SIZE = 'h-[60vh] w-[33vw] max-w-none min-w-[22rem] sm:max-w-none max-sm:h-dvh max-sm:w-screen max-sm:min-w-0 max-sm:rounded-none';",
    "<DialogContent className={cn('flex flex-col gap-0 overflow-hidden p-0', PANEL_SIZE)}",
    "<DialogHeader className='border-b p-4 pr-12'>",
    "<DialogTitle className='flex items-center gap-2'><IconSparkles className='text-primary size-4' /> Ask AI</DialogTitle>",
    "<div className='relative min-h-0 flex-1'>",
    "className='flex h-full flex-col gap-6 overflow-y-auto p-4' data-ask-messages>",
    "<form className='flex flex-col gap-1.5 border-t p-3' data-composer",
    "aria-label='Your question' placeholder={about}",
    "<p className='text-destructive text-sm' role='alert'>{error}</p>",
    "<div className='flex flex-col gap-2' aria-live='polite' aria-busy={streaming} data-answer>",
    "className='max-w-none text-sm [&_a]:no-underline [&_p]:my-2 [&_p]:leading-6 [&_ul]:my-2'>{linked(text, sources)}</Markdown>",
    "<span className='bg-primary inline-block h-4 w-1.5 animate-pulse rounded-sm' aria-hidden />",
    "<p className='text-muted-foreground text-xs'>",
    "<p className='text-muted-foreground text-sm'>",
    "<div className='flex flex-col gap-2 border-t pt-3' data-sources>",
    "<span className='text-muted-foreground text-xs font-medium tracking-wider uppercase'>Sources</span>",
    "<ol className='flex flex-col gap-1'>",
    "<li key={s.n} className='flex gap-2 text-sm'>",
    "<span className='text-muted-foreground w-5 shrink-0 text-right tabular-nums'>{s.n}.</span>",
    "<Link href={s.href} className='hover:text-primary min-w-0 transition-colors'",
  ],
  "components/kbar/ui.tsx": [
    `"${BUTTON_BASE}"`,
    `'${BUTTON_OUTLINE}'`,
    "'border-border hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50'",
    "'h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2'",
    "'size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg'",
    "'h-8 w-full min-w-0 rounded-lg border border-border bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40'",
    `"${KBD}"`,
    "'size-4 animate-spin'",
    "'fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0'",
    "'fixed top-1/2 left-1/2 z-50 grid grid-cols-[minmax(0,1fr)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95'",
    "<Button variant='ghost' className='absolute top-2 right-2' size='icon-sm'>",
    "<span className='sr-only'>Close</span>",
    "'flex flex-col gap-2'",
    "'text-base leading-none font-medium'",
  ],
  "components/kbar/markdown.tsx": [
    "'text-primary decoration-primary/40 hover:decoration-primary font-medium underline underline-offset-4 transition-colors'",
    "<p className='my-4 leading-7' {...p} />",
    "'marker:text-muted-foreground my-4 ml-6 list-disc space-y-2 [&_ol]:my-2 [&_ul]:my-2'",
    "'marker:text-muted-foreground my-4 ml-6 list-decimal space-y-2 [&_ol]:my-2 [&_ul]:my-2'",
    "<li className='pl-1 leading-7 [&>p]:my-1' {...p} />",
    "<strong className='text-foreground font-semibold' {...p} />",
    "'bg-muted rounded-md border px-1.5 py-0.5 font-mono text-[0.85em] break-words'",
    "'text-foreground max-w-3xl text-[15px] break-words'",
  ],
};

describe("the search's look, pinned", () => {
  it("every class string and piece of markup is in its file exactly as designed", () => {
    for (const [file, strings] of Object.entries(PINNED)) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      for (const s of strings) expect(source.includes(s), `${file}: ${s}`).toBe(true);
    }
  });

  it("its colours, radius and shadow are scoped to what the search draws, in light and dark", () => {
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
    const block = (selector: string) => css.slice(css.indexOf(`${selector} {`), css.indexOf("}", css.indexOf(`${selector} {`)));
    const light = block("\n.search-port");
    const dark = block("\n.dark .search-port");
    const tokens = ["--background", "--foreground", "--popover", "--popover-foreground", "--primary", "--primary-foreground", "--muted", "--muted-foreground", "--accent", "--accent-foreground", "--destructive", "--border", "--input", "--ring"];
    for (const t of tokens) {
      expect(light, t).toContain(`${t}: oklch(`);
      expect(dark, t).toContain(`${t}: oklch(`);
    }
    expect(light).toContain("--radius: 0.5rem;");
    expect(light).toContain("--popover: oklch(0.9911 0 0);");
    expect(light).toContain("--primary: oklch(0.406 0.161 272.2);");
    expect(dark).toContain("--popover: oklch(0.2393 0 0);");
    expect(dark).toContain("--accent: oklch(0.3132 0 0);");
    expect(css).toContain(".search-port .shadow-lg {\n  --tw-shadow: 0px 1px 3px 0px hsl(0 0% 0% / 0.17), 0px 4px 6px -1px hsl(0 0% 0% / 0.17);");
    // Nothing outside the search takes them.
    expect(css.match(/search-port/g)).toHaveLength(6);
  });

  it("the header's search: an icon button named Search on a phone, a box with its ⌘K key from tablet width up", () => {
    render(
      <KBar>
        <SearchInput />
      </KBar>,
    );
    const wrap = document.querySelector("[data-search-input]")!;
    expect(classOf(wrap)).toBe("search-port contents");
    const [phone, box] = [...wrap.querySelectorAll("button")];
    expect(wrap.querySelectorAll("button")).toHaveLength(2);
    // The icon alone, named for a screen reader.
    expect(phone.getAttribute("aria-label")).toBe("Search");
    expect(phone.textContent).toBe("");
    for (const c of ["h-11", "min-w-11", "rounded-[0.5rem]", "px-0", "shadow-none", "md:h-9", "md:min-w-9", "md:hidden", "border", "border-border", "bg-background"]) expect(classOf(phone)!.split(" "), c).toContain(c);
    expect(classOf(phone.querySelector("svg"))).toBe("tabler-icon tabler-icon-search h-4 w-4");
    expect(box.textContent).toBe("Search...⌘K");
    for (const c of ["h-11", "rounded-[0.5rem]", "md:h-9", "bg-background", "text-muted-foreground", "relative", "hidden", "justify-start", "font-normal", "sm:pr-12", "md:flex", "md:w-40", "md:px-3", "lg:w-64"])
      expect(classOf(box)!.split(" "), c).toContain(c);
    expect(classOf(box.querySelector("svg"))).toBe("tabler-icon tabler-icon-search mr-2 h-4 w-4");
    expect(classOf(box.querySelector("kbd"))).toBe("bg-muted pointer-events-none absolute top-[0.3rem] right-[0.3rem] hidden h-6 items-center gap-1 rounded border px-1.5 font-mono text-[10px] font-medium opacity-100 select-none sm:flex");
    expect(box.querySelector("kbd")!.innerHTML).toBe('<span class="text-xs">⌘</span>K');
  });

  it("the bar: its backdrop, panel, search field, results area and foot", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    render(
      <KBar area="admin">
        <SearchInput />
      </KBar>,
    );
    expect(document.querySelector("[role=combobox]")).toBeNull();
    await act(async () => {
      fireEvent.click(document.querySelectorAll("[data-search-trigger]")[1]);
    });
    await act(async () => undefined);
    const input = document.querySelector("input[role=combobox]") as HTMLInputElement;
    expect(classOf(input)).toBe("placeholder:text-muted-foreground w-full border-none bg-transparent px-4 py-3.5 text-sm outline-hidden focus:ring-0 focus:outline-hidden");
    expect(input.placeholder).toBe("Type a command or search…");
    expect(classOf(input.parentElement)).toBe("bg-popover sticky top-0 z-10 border-b");
    const panel = input.parentElement!.parentElement!.parentElement!;
    expect(classOf(panel)).toBe("bg-popover text-popover-foreground ring-foreground/10 relative mx-auto w-full max-w-[600px] overflow-hidden rounded-xl shadow-lg ring-1");
    expect(classOf(panel.parentElement)).toBe("search-port bg-black/10 supports-backdrop-filter:backdrop-blur-xs fixed inset-0 z-99999 flex items-start! justify-center p-4! pt-[14vh]!");
    expect(classOf(input.parentElement!.nextElementSibling)).toBe("h-[400px]");
    const foot = input.parentElement!.parentElement!.lastElementChild!;
    expect(classOf(foot)).toBe("text-muted-foreground flex items-center gap-3 border-t px-3 py-2 text-xs");
    expect(foot.textContent).toBe("↑↓ navigate↵ openesc close");
    expect([...foot.querySelectorAll("kbd")].map(classOf)).toEqual([KBD, KBD, KBD, KBD]);
  });

  it("the bar's foot: the keys, each a key cap", () => {
    expect(renderToStaticMarkup(<KBarFooter />)).toBe(
      `<div class="text-muted-foreground flex items-center gap-3 border-t px-3 py-2 text-xs"><span class="flex items-center gap-1"><kbd data-slot="kbd" class="${KBD.replace(/&/g, "&amp;").replace(/'/g, "&#x27;")}">↑</kbd><kbd data-slot="kbd" class="${KBD.replace(/&/g, "&amp;").replace(/'/g, "&#x27;")}">↓</kbd> navigate</span><span class="flex items-center gap-1"><kbd data-slot="kbd" class="${KBD.replace(/&/g, "&amp;").replace(/'/g, "&#x27;")}">↵</kbd> open</span><span class="flex items-center gap-1"><kbd data-slot="kbd" class="${KBD.replace(/&/g, "&amp;").replace(/'/g, "&#x27;")}">esc</kbd> close</span></div>`,
    );
  });

  it("a result row: icon, what it's under, its name, its subtitle and its keys; the active row is filled", () => {
    const row = (active: boolean, action: Partial<Parameters<typeof ResultItem>[0]["action"]>) =>
      renderToStaticMarkup(<ResultItem active={active} currentRootActionId="" action={{ id: "a", name: "Licences", subtitle: undefined, icon: undefined, shortcut: undefined, ancestors: [], ...action } as never} />);
    expect(row(false, {})).toBe(`<div class="${ROW}"><div class="flex items-center gap-2"><div class="flex flex-col"><div><span>Licences</span></div></div></div></div>`);
    expect(row(true, { subtitle: "Go to Licences" })).toBe(
      `<div class="${ROW} bg-accent text-accent-foreground"><div class="flex items-center gap-2"><div class="flex flex-col"><div><span>Licences</span></div><span class="text-muted-foreground text-xs">Go to Licences</span></div></div></div>`,
    );
    const nested = row(false, { ancestors: [{ id: "platform:/platform/firms", name: "Regulated firms" }] as never, shortcut: ["g", "l"] });
    expect(nested).toContain('<span class="text-muted-foreground mr-2">Regulated firms</span><span class="mr-2">›</span><span>Licences</span>');
    expect(nested).toContain('<div class="grid grid-flow-col gap-1"><kbd data-slot="kbd"');
    // A browse entry is the section's own header: what's under it reads on its own.
    expect([...BROWSE_IDS]).toEqual(["members", "audit-actions"]);
    expect(row(false, { name: "Ines Diaz", ancestors: [{ id: "members", name: "Members" }] as never })).toContain("<div><span>Ines Diaz</span></div>");
  });

  it("the Ask row: a sparkle, the question and what it gives", () => {
    const a = askAction("which apps are live", () => undefined);
    expect(a).toMatchObject({ id: "ask-ai", name: "Ask AI: which apps are live", keywords: "which apps are live", priority: 10, section: { name: "Ask AI", priority: 10 }, subtitle: "An answer from Mynt's data, with its sources" });
    expect(renderToStaticMarkup(a.icon)).toContain('class="tabler-icon tabler-icon-sparkles text-primary size-4"');
  });
});

// ---------- what it lists ----------

// What the bar lists for what's typed, as kbar matches it: section headers (strings) and actions.
type Listed = { section: string; name: string; under: string[] };
const seen = { rows: [] as (string | Listed)[], perform: (_name: string) => undefined as void };
function Probe() {
  const { results } = useMatches();
  seen.rows = results.map((r) => (typeof r === "string" ? r : { section: typeof r.section === "string" ? r.section : (r.section?.name ?? ""), name: r.name, under: r.ancestors.map((a) => a.name) }));
  seen.perform = (name) => void results.find((r): r is Exclude<typeof r, string> => typeof r !== "string" && r.name === name)?.command?.perform();
  return null;
}
const sections = () => seen.rows.filter((r): r is string => typeof r === "string");
const names = (section?: string) => seen.rows.filter((r): r is Listed => typeof r !== "string" && (!section || r.section === section)).map((r) => r.name);
const openBar = async () => {
  await act(async () => {
    fireEvent.click(document.querySelectorAll("[data-search-trigger]")[1]);
  });
  await settle();
};
// kbar matches what's typed a moment after it's typed.
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 160))));
const type = async (value: string) => {
  await act(async () => {
    fireEvent.change(document.querySelector("input[role=combobox]")!, { target: { value } });
  });
  await settle();
};

const sse = (events: unknown[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the platform admin's search", () => {
  const stub = (askEnabled = true) => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (init?.method === "POST")
        return sse([
          { type: "sources", sources: [{ n: 1, title: "Regulated firms › Licences", href: "/platform/firms?tab=licences", tool: "list_license_reviews", readAt: "2026-11-26T10:42:00Z" }] },
          { type: "done", answer: "Atlas Trust Bank is waiting on a licence review [1].", covered: true, model: "claude-opus-5-5", reason: null },
        ]);
      if (url === "/api/admin/ask") return json({ enabled: askEnabled });
      if (url === "/api/admin/workspaces") return json({ workspaces: [{ id: WS, name: "Harbor Lending", personal: false, status: "active" }], total: 1 });
      if (url === "/api/admin/firms") return json({ firms: [{ id: FIRM, name: "Atlas Trust Bank", status: "active", country: "US" }] });
      return json({});
    });
    return calls;
  };
  const mount = () =>
    render(
      <KBar area="admin">
        <SearchInput />
        <Probe />
      </KBar>,
    );

  it("loads nothing until it opens; then lists its sections first and Studio's pages after, with no workspace read", async () => {
    const calls = stub();
    mount();
    await act(async () => undefined);
    expect(calls).toEqual([]);
    await openBar();
    expect(calls.map((c) => c.url).sort()).toEqual(["/api/admin/ask", "/api/admin/firms", "/api/admin/workspaces"]);
    expect(sections()).toEqual(["Platform admin", "Studio"]);
    expect(names("Platform admin")).toEqual(["Overview", "Workspaces", "Regulated firms", "Vendors", "Audit trails", "Risk models", "Risk register", "Platform settings"]);
    expect(names("Studio")).toContain("Studio: Dashboard");
    // Workspaces, firms and the Licences tab are found by typing, never listed.
    expect(names()).not.toContain("Harbor Lending");
    expect(names()).not.toContain("Licences");
  });

  it("typing finds a workspace, a firm and the Licences tab, each under its section; Enter opens it", async () => {
    stub();
    mount();
    await openBar();
    await type("harbor");
    expect(seen.rows).toContainEqual({ section: "Workspaces", name: "Harbor Lending", under: ["Workspaces"] });
    await type("atlas");
    expect(seen.rows).toContainEqual({ section: "Regulated firms", name: "Atlas Trust Bank", under: ["Regulated firms"] });
    await act(async () => {
      fireEvent.keyDown(window, { key: "Enter" });
    });
    expect(nav.pushed).toEqual([`/platform/firms/${FIRM}`]);
    await openBar();
    await type("licences");
    expect(seen.rows).toContainEqual({ section: "Platform admin", name: "Licences", under: ["Regulated firms"] });
  });

  it("a question is offered to Ask AI first; asking closes the bar, sends it to /api/admin/ask and shows the answer with its sources", async () => {
    const calls = stub();
    mount();
    await openBar();
    await type("firms");
    expect(sections()).not.toContain("Ask AI");
    const question = "Which regulated firms are waiting on a licence review?";
    await type(question);
    expect(seen.rows.slice(0, 2)).toEqual(["Ask AI", { section: "Ask AI", name: `Ask AI: ${question}`, under: [] }]);
    await act(async () => {
      fireEvent.keyDown(window, { key: "Enter" });
    });
    await act(async () => undefined);
    await act(async () => undefined);
    expect(calls.filter((c) => c.body)).toEqual([{ url: "/api/admin/ask", body: { question, history: [] } }]);
    expect(calls.some((c) => c.url === "/api/ask" || c.url.startsWith("/api/workspaces") || c.url.startsWith("/api/projects"))).toBe(false);
    const dialog = document.querySelector("[data-slot=dialog-content]")!;
    expect(dialog.querySelector("[data-answer]")!.textContent).toContain("Atlas Trust Bank is waiting on a licence review");
    expect(dialog.querySelector("[data-cite] a")!.getAttribute("href")).toBe("/platform/firms?tab=licences");
    expect(dialog.textContent).toContain("AI summary from Mynt's data — may be imperfect (claude-opus-5-5).");
    expect([...dialog.querySelectorAll("[data-sources] ol a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["Regulated firms › Licences", "/platform/firms?tab=licences"]]);
    expect(dialog.getAttribute("data-ask-panel")).toBe("admin");
    // Closed, the conversation is kept for the visit: the bar offers the way back to it.
    await act(async () => {
      fireEvent.keyDown(dialog, { key: "Escape" });
    });
    expect(document.querySelector("[data-slot=dialog-content]")).toBeNull();
    await openBar();
    expect(seen.rows.slice(0, 2)).toEqual(["Ask AI", { section: "Ask AI", name: "Ask AI: back to the conversation", under: [] }]);
    await act(async () => {
      seen.perform("Ask AI: back to the conversation");
    });
    expect(document.querySelector("[data-slot=dialog-content] [data-question]")!.textContent).toBe(question);
    expect(calls.filter((c) => c.body)).toHaveLength(1);
  });

  it("with no model configured there is no Ask AI row; search still works", async () => {
    const calls = stub(false);
    mount();
    await openBar();
    await type("what needs attention today?");
    expect(sections()).not.toContain("Ask AI");
    await type("vendors");
    expect(names("Platform admin")).toContain("Vendors");
    expect(calls.some((c) => c.body)).toBe(false);
  });
});

describe("Studio's search", () => {
  const stub = () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      const path = url.split("?")[0];
      if (path === "/api/liquidity/access") return json({ developer: true, admin: false, access: { builder: true, liquidityProvider: false }, owner: "o" });
      if (path === "/api/workspaces") return json({ supported: true, workspaces: [{ id: "w1", name: "Acme", role: "owner" }] });
      if (path === "/api/projects") return json({ projects: [{ id: "a1", name: "Round-up savings", stage: "production" }, { id: "a2", name: "Budgeting", stage: "staging" }] });
      if (path === "/api/products") return json({ mine: [] });
      if (path === "/api/workspaces/w1/members") return json({ members: [{ userId: "u1", name: "Ines Diaz", email: "ines@example.com", role: "owner" }] });
      if (path === "/api/audit") return json({ page: { events: [{ action: "app.created" }] } });
      if (path === "/api/ask") return json({ enabled: true });
      return json({});
    });
    return calls;
  };
  const mount = async () => {
    render(
      <WorkspaceProvider enabled>
        <KBar>
          <SearchInput />
          <Probe />
        </KBar>
      </WorkspaceProvider>,
    );
    await act(async () => undefined);
    await act(async () => undefined);
  };

  it("lists pages and the workspace's apps; members and audit actions are browsed or found by typing", async () => {
    const calls = stub();
    await mount();
    expect(calls.some((u) => u.startsWith("/api/projects") || u.startsWith("/api/ask"))).toBe(false);
    await openBar();
    await act(async () => undefined);
    expect(sections()).toEqual(["Pages", "Apps", "Members", "Audit actions"]);
    expect(names("Pages")).toContain("Dashboard");
    expect(names("Apps")).toEqual(["Round-up savings", "Budgeting"]);
    expect(names("Members")).toEqual(["Members"]);
    expect(names("Audit actions")).toEqual(["Audit actions"]);
    // No platform admin sections for someone who isn't a Mynt admin.
    expect(names().some((n) => n.startsWith("Platform admin"))).toBe(false);
    await type("ines");
    expect(seen.rows).toContainEqual({ section: "Members", name: "Ines Diaz", under: ["Members"] });
    await type("budgeting security");
    expect(seen.rows).toContainEqual({ section: "Apps", name: "Security & risk", under: ["Budgeting"] });
    await type("budgeting");
    await act(async () => {
      seen.perform("Budgeting");
    });
    expect(nav.pushed).toEqual(["/a2"]);
  });

  it("offers Ask AI for a question (a few words, or one ending in a question mark), never for a word", async () => {
    stub();
    await mount();
    await openBar();
    for (const [typed, offered] of [["budg", false], ["budgeting", false], ["apps?", false], ["budgets?", true], ["which apps are live", true]] as const) {
      await type(typed);
      expect(sections().includes("Ask AI"), typed).toBe(offered);
    }
    expect(seen.rows[1]).toEqual({ section: "Ask AI", name: "Ask AI: which apps are live", under: [] });
  });
});

describe("the bar's actions, from what Mynt's search finds", () => {
  it("Studio: a page goes to itself, an app's tab sits under its app, members and audit actions under their browse entries", () => {
    const actions = searchActions("studio", searchIndex({ apps: [{ id: "a2", name: "Budgeting", stage: "staging" }], members: [{ userId: "u1", name: "Ines Diaz", email: null, role: "owner" }], auditActions: ["app.created"], admin: true }));
    const by = (id: string) => actions.find((a) => a.id === id)!;
    // Six sections now (Services joined Pages, Apps, Financial products, Members and Audit actions), so the first two rank one higher.
    expect(by("page:/licences")).toMatchObject({ name: "Licences", section: { name: "Pages", priority: 6 }, subtitle: "Go to Licences", href: "/licences" });
    expect(by("app:a2")).toMatchObject({ name: "Budgeting", section: { name: "Apps", priority: 5 }, subtitle: "Staging", href: "/a2" });
    expect(by("apptab:a2:security")).toMatchObject({ name: "Security & risk", parent: "app:a2", subtitle: "App tab", href: "/a2?tab=security" });
    expect(by("members")).toMatchObject({ name: "Members", section: { name: "Members", priority: 2 } });
    expect(by("members").href).toBeUndefined();
    expect(by("member:u1")).toMatchObject({ name: "Ines Diaz", parent: "members", subtitle: "owner", href: "/settings?tab=members" });
    expect(by("audit:app.created")).toMatchObject({ parent: "audit-actions", href: "/audits?action=app.created" });
    expect(by("page:/platform/firms?tab=licences")).toMatchObject({ name: "Licences", parent: "page:/platform/firms" });
    expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length);
  });

  it("the platform admin: sections, workspaces and firms under their sections, Studio's pages last", () => {
    const actions = searchActions("admin", platformSearchIndex({ workspaces: [{ id: WS, name: "Harbor Lending", status: "active" }], firms: [{ id: FIRM, name: "Atlas Trust Bank", country: "US", status: "active" }] }));
    const by = (id: string) => actions.find((a) => a.id === id)!;
    expect(by("platform:/platform/audit")).toMatchObject({ name: "Audit trails", section: { name: "Platform admin", priority: 4 }, subtitle: "Go to Audit trails", href: "/platform/audit" });
    expect(by(`workspace:${WS}`)).toMatchObject({ name: "Harbor Lending", parent: "platform:/platform/workspaces", section: { name: "Workspaces", priority: 3 }, subtitle: "active", href: `/platform/workspaces/${WS}` });
    expect(by(`firm:${FIRM}`)).toMatchObject({ name: "Atlas Trust Bank", parent: "platform:/platform/firms", subtitle: "US · active", href: `/platform/firms/${FIRM}` });
    expect(by("studio:/docs")).toMatchObject({ name: "Studio: Docs", section: { name: "Studio", priority: 1 }, href: "/docs" });
  });
});

// ---------- the Ask AI panel ----------

describe("the Ask AI panel", () => {
  const at = "2026-11-26T10:42:00Z";
  const SOURCES = [
    { n: 1, title: "Dashboard › Apps", href: "/", tool: "list_my_apps", readAt: at },
    { n: 2, title: "Apps › Round-up savings", href: "/a1", tool: "list_my_apps", readAt: at },
    { n: 3, title: "Licences", href: "/licences", tool: "list_workspace_licences", readAt: at },
  ];
  const TEXT = "You have one app, Round-up savings [2]. Its licence is verified [3][9].";
  const ANSWER = [
    { type: "reasoning", id: "r1", text: "The user wants " },
    { type: "reasoning", id: "r1", text: "their apps." },
    { type: "delta", text: "Let me look." },
    { type: "reset" },
    { type: "tool_start", id: "s1", tool: "list_my_apps", label: "Read apps and their stages", args: "workspace_id: 44444444…" },
    { type: "sources", sources: SOURCES.slice(0, 2) },
    { type: "tool_end", id: "s1", ok: true, ms: 420, summary: "1 app", result: '{\n "apps": [\n  {\n   "name": "Round-up savings"\n  }\n ]\n}' },
    { type: "tool_start", id: "s2", tool: "get_build", label: "Read a build", args: "build_id: b1" },
    { type: "tool_end", id: "s2", ok: false, ms: 80, summary: "Failed", message: "No build 'b1'" },
    { type: "sources", sources: SOURCES },
    { type: "delta", text: TEXT },
    { type: "done", answer: TEXT, covered: true, model: "claude-opus-5-5", reason: null, uncited: false, thoughtMs: 6200 },
  ];
  let asked: { url: string; body: { question: string; history: unknown[] } }[] = [];
  const stub = (reply: (n: number) => Response) =>
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      asked.push({ url, body: JSON.parse(String(init!.body)) });
      return reply(asked.length);
    });
  // A stream the test writes to, an event at a time.
  const live = () => {
    const encoder = new TextEncoder();
    let push: (e: unknown) => void = () => undefined;
    let end: () => void = () => undefined;
    const res = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          push = (e) => c.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
          end = () => c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const write = async (...events: unknown[]) =>
      act(async () => {
        for (const e of events) push(e);
        await new Promise((r) => setTimeout(r, 10));
      });
    return { res, write, end: () => end() };
  };
  function Opener({ question }: { question: string }) {
    const ask = useAskAi();
    return (
      <button type="button" data-opener onClick={() => ask(question)}>
        open
      </button>
    );
  }
  const open = async (area: "studio" | "admin" = "studio", question = "Which apps do I have?") => {
    render(
      <AskAiProvider area={area}>
        <Opener question={question} />
      </AskAiProvider>,
    );
    await act(async () => {
      fireEvent.click(document.querySelector("[data-opener]")!);
    });
    await act(async () => undefined);
    await act(async () => undefined);
  };
  const panel = () => document.querySelector("[data-slot=dialog-content]")!;
  const field = () => panel().querySelector("textarea[name=question]") as HTMLTextAreaElement;
  const button = (name: string | RegExp) => [...panel().querySelectorAll("button")].find((b) => (typeof name === "string" ? b.textContent!.trim() === name : name.test(b.textContent!.trim()))) as HTMLButtonElement | undefined;
  const typeIn = async (value: string) =>
    act(async () => {
      fireEvent.change(field(), { target: { value } });
    });
  const press = async (init: KeyboardEventInit) => {
    await act(async () => {
      fireEvent.keyDown(field(), init);
    });
    await act(async () => undefined);
    await act(async () => undefined);
  };
  beforeEach(() => {
    asked = [];
  });

  it("its size is fixed: 60% of the screen's height and a third of its width, never under 22rem; the whole screen below sm", async () => {
    expect(PANEL_SIZE).toBe("h-[60vh] w-[33vw] max-w-none min-w-[22rem] sm:max-w-none max-sm:h-dvh max-sm:w-screen max-sm:min-w-0 max-sm:rounded-none");
    stub(() => sse(ANSWER));
    await open();
    const classes = classOf(panel())!.split(" ");
    for (const c of [...PANEL_SIZE.split(" "), "search-port", "fixed", "top-1/2", "left-1/2", "-translate-x-1/2", "-translate-y-1/2", "z-50", "flex", "flex-col", "gap-0", "overflow-hidden", "p-0", "rounded-xl", "bg-popover", "text-popover-foreground", "ring-1", "ring-foreground/10"])
      expect(classes, c).toContain(c);
    // Nothing of the old size is left to fight it.
    for (const c of ["grid", "w-full", "sm:max-w-sm", "max-w-[calc(100%-2rem)]", "max-h-[85svh]", "overflow-y-auto"]) expect(classes, c).not.toContain(c);
  });

  it("its layout: the header, the messages (which scroll), and the question field pinned at the foot", async () => {
    stub(() => sse(ANSWER));
    await open();
    const [header, middle, composer] = [...panel().children];
    expect(classOf(header)).toBe("flex flex-col gap-2 border-b p-4 pr-12");
    const title = header.querySelector("[data-slot=dialog-title]")!;
    expect(classOf(title)).toBe("text-base leading-none font-medium flex items-center gap-2");
    expect(title.textContent).toBe(" Ask AI");
    expect(classOf(title.querySelector("svg"))).toBe("tabler-icon tabler-icon-sparkles text-primary size-4");
    expect(button("New chat")).toBeTruthy();
    // The messages take what's left and scroll inside it.
    expect(classOf(middle)).toBe("relative min-h-0 flex-1");
    expect(classOf(middle.firstElementChild)).toBe("flex h-full flex-col gap-6 overflow-y-auto p-4");
    // The question field is the panel's last row, outside what scrolls.
    expect(composer.tagName).toBe("FORM");
    expect(composer.hasAttribute("data-composer")).toBe(true);
    expect(classOf(composer)).toBe("flex flex-col gap-1.5 border-t p-3");
    expect(middle.contains(field())).toBe(false);
    expect(composer.contains(field())).toBe(true);
    expect(field().getAttribute("aria-label")).toBe("Your question");
    expect(field().rows).toBe(1);
    expect(field().maxLength).toBe(400);
    expect(field().placeholder).toBe("Ask about your Mynt data");
    for (const c of ["max-h-[7.5rem]", "min-h-8", "flex-1", "resize-none", "rounded-lg", "border", "border-border", "bg-transparent"]) expect(classOf(field())!.split(" "), c).toContain(c);
    // Every control has its name in words; the close X is named for a screen reader.
    expect(button("Send")).toBeTruthy();
    const close = panel().querySelector("[data-slot=dialog-close]")!;
    expect(close.textContent).toBe("Close");
    expect(classOf(close.querySelector("span"))).toBe("sr-only");
    for (const b of panel().querySelectorAll("button")) expect(b.textContent!.trim(), b.outerHTML.slice(0, 80)).not.toBe("");
  });

  it("opens with the question already asked, and shows the answer under its steps on one line", async () => {
    stub(() => sse(ANSWER));
    await open();
    expect(asked).toEqual([{ url: "/api/ask", body: { question: "Which apps do I have?", history: [] } }]);
    const turn = panel().querySelector("[data-turn]")!;
    expect(turn.querySelector("[data-question]")!.textContent).toBe("Which apps do I have?");
    // Collapsed: one line, with what it took.
    const steps = turn.querySelector("[data-steps]")!;
    const line = steps.querySelector("button")!;
    expect(line.textContent!.trim()).toBe("Used 2 reads · Thought for 6s");
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(steps.querySelector("ol")).toBeNull();
    // What was written before the read was dropped.
    expect(turn.querySelector("[data-answer]")!.textContent).toContain("You have one app, Round-up savings");
    expect(turn.textContent).not.toContain("Let me look.");
    expect(turn.textContent).toContain("AI summary from your Mynt data — may be imperfect (claude-opus-5-5).");
    expect(turn.querySelector("[data-uncited]")).toBeNull();
    // The steps come before the answer.
    expect(steps.compareDocumentPosition(turn.querySelector("[data-answer]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the line opens into the steps, in order: the model's thinking as it wrote it, then each read with its name, arguments, outcome and result", async () => {
    stub(() => sse(ANSWER));
    await open();
    const steps = panel().querySelector("[data-steps]")!;
    await act(async () => {
      fireEvent.click(steps.querySelector("button")!);
    });
    expect(steps.querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
    const items = [...steps.querySelectorAll(":scope > ol > li")];
    expect(items.map((li) => li.getAttribute("data-step"))).toEqual(["reasoning", "tool", "tool"]);
    expect(items[0].textContent).toBe("ThinkingThe user wants their apps.");
    expect(classOf(items[0].querySelector("p"))).toBe("bg-muted/60 rounded-md p-2 leading-relaxed whitespace-pre-wrap");
    // A read: its name in words with the tool's own name in a code tag, its arguments, how it went.
    expect(items[1].querySelector(".font-medium")!.textContent).toBe("Read apps and their stages");
    expect(items[1].querySelector("code")!.textContent).toBe("list_my_apps");
    expect(items[1].textContent).toContain("workspace_id: 44444444…");
    expect(items[1].textContent).toContain("Done · 1 app · under a second");
    expect(items[1].getAttribute("data-status")).toBe("done");
    expect(items[1].querySelector("pre")).toBeNull();
    await act(async () => {
      fireEvent.click([...items[1].querySelectorAll("button")].find((b) => b.textContent!.trim() === "Show result")!);
    });
    expect(items[1].querySelector("pre")!.textContent).toContain('"name": "Round-up savings"');
    expect([...items[1].querySelectorAll("button")].some((b) => b.textContent!.trim() === "Hide result")).toBe(true);
    // A read Mynt refused: failed, with Mynt's message, and no result to show.
    expect(items[2].getAttribute("data-status")).toBe("failed");
    expect(items[2].textContent).toContain("Failed: No build 'b1'");
    expect(items[2].querySelector("button")).toBeNull();
  });

  it("a model that returned no thinking shows none; an answer with no steps has no line", async () => {
    stub((n) =>
      n === 1
        ? sse([{ type: "tool_start", id: "s1", tool: "list_my_apps", label: "Read apps and their stages", args: "" }, { type: "tool_end", id: "s1", ok: true, ms: 10, summary: "0 apps", result: "[]" }, { type: "done", answer: "You have no apps yet [1].", covered: true, model: "m", reason: null }])
        : sse([{ type: "done", answer: "Mynt's data doesn't cover this.", covered: false, model: "m", reason: null }]),
    );
    await open();
    expect(panel().querySelector("[data-steps] button")!.textContent!.trim()).toBe("Used 1 read");
    await typeIn("What is the weather?");
    await press({ key: "Enter" });
    const turns = panel().querySelectorAll("[data-turn]");
    expect(turns).toHaveLength(2);
    expect(turns[1].querySelector("[data-steps]")).toBeNull();
    expect(panel().textContent).not.toContain("Thinking");
  });

  it("citations are chips: the source's number, linked to its record, with its title and when it was read on hover or focus", async () => {
    stub(() => sse(ANSWER));
    await open();
    const answer = panel().querySelector("[data-answer]")!;
    const chips = [...answer.querySelectorAll("[data-cite]")];
    expect(chips.map((c) => c.getAttribute("data-cite"))).toEqual(["2", "3"]);
    // A citation of a source it wasn't given stays text, never a link.
    expect(answer.textContent).toContain("[9]");
    const chip = chips[0];
    expect(classOf(chip)).toBe("group/cite relative inline-block");
    const link = chip.querySelector("a")!;
    expect(link.textContent).toBe("2");
    expect(link.getAttribute("href")).toBe("/a1");
    expect(link.getAttribute("aria-label")).toBe("Source 2: Apps › Round-up savings");
    expect(classOf(link)).toBe(CITE);
    const tip = chip.querySelector("[role=tooltip]")!;
    expect(classOf(tip)).toBe(CITE_TIP);
    for (const c of ["hidden", "group-hover/cite:block", "group-focus-within/cite:block"]) expect(CITE_TIP.split(" "), c).toContain(c);
    expect(tip.textContent).toMatch(/^Apps › Round-up savings · read \d/);
    // Under the answer, its sources, numbered, each with its title and its page.
    const sources = panel().querySelector("[data-sources]")!;
    expect(sources.firstElementChild!.outerHTML).toBe('<span class="text-muted-foreground text-xs font-medium tracking-wider uppercase">Sources</span>');
    expect([...sources.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["1.Dashboard › Apps", "2.Apps › Round-up savings", "3.Licences"]);
    expect([...sources.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["/", "/a1", "/licences"]);
    expect(sources.querySelector("a")!.getAttribute("title")).toMatch(/^Read \d.* · list_my_apps$/);
    // Following one closes the panel as its page opens.
    link.addEventListener("click", (e) => e.preventDefault()); // jsdom doesn't navigate
    await act(async () => {
      fireEvent.click(link);
    });
    expect(document.querySelector("[data-slot=dialog-content]")).toBeNull();
  });

  it("a follow-up is asked with Enter and carries the conversation so far; Shift+Enter starts a new line; each answer numbers its own sources", async () => {
    stub((n) => (n === 1 ? sse(ANSWER) : sse([{ type: "sources", sources: [{ n: 1, title: "Apps › Round-up savings", href: "/a1", tool: "list_my_apps", readAt: at }] }, { type: "done", answer: "It is in production [1].", covered: true, model: "m", reason: null }])));
    await open();
    // After an answer the question field has focus again.
    expect(document.activeElement).toBe(field());
    // Too short to be a question: Send is off, and Enter asks nothing.
    await typeIn("hi");
    expect(button("Send")!.disabled).toBe(true);
    await press({ key: "Enter" });
    expect(asked).toHaveLength(1);
    await typeIn("What stage is it in?");
    expect(button("Send")!.disabled).toBe(false);
    await press({ key: "Enter", shiftKey: true });
    expect(asked).toHaveLength(1);
    expect(field().value).toBe("What stage is it in?");
    await press({ key: "Enter" });
    expect(asked).toHaveLength(2);
    expect(asked[1]).toEqual({
      url: "/api/ask",
      body: { question: "What stage is it in?", history: [{ role: "user", text: "Which apps do I have?" }, { role: "assistant", text: TEXT }] },
    });
    expect(field().value).toBe("");
    const turns = [...panel().querySelectorAll("[data-turn]")];
    expect(turns.map((t) => t.querySelector("[data-question]")!.textContent)).toEqual(["Which apps do I have?", "What stage is it in?"]);
    // The first answer keeps its own sources; the follow-up's [1] is its own first source.
    expect(turns[0].querySelectorAll("[data-sources] li")).toHaveLength(3);
    expect([...turns[1].querySelectorAll("[data-sources] li")].map((li) => li.textContent)).toEqual(["1.Apps › Round-up savings"]);
    expect(turns[1].querySelector("[data-cite] a")!.getAttribute("href")).toBe("/a1");
    // Only the last answer can be asked again; each can be copied.
    expect(turns.map((t) => [...t.querySelectorAll("button")].some((b) => b.textContent!.trim() === "Ask again"))).toEqual([false, true]);
    expect(turns.map((t) => [...t.querySelectorAll("button")].some((b) => b.textContent!.trim() === "Copy answer"))).toEqual([true, true]);
  });

  it("the count shows near the 400-character limit, and the Send button is the form's", async () => {
    stub(() => sse(ANSWER));
    await open();
    await typeIn("x".repeat(349));
    expect(panel().querySelector("[data-composer]")!.textContent).not.toContain("/400");
    await typeIn(`why ${"x".repeat(360)}`);
    expect(panel().querySelector("[data-composer]")!.textContent).toContain("364/400");
    expect(button("Send")!.type).toBe("submit");
    await act(async () => {
      fireEvent.submit(panel().querySelector("[data-composer]")!);
    });
    await act(async () => undefined);
    expect(asked).toHaveLength(2);
  });

  it("while an answer is coming: the line says what it's doing, Send is Stop, and Stop ends it with what was written", async () => {
    const s = live();
    stub(() => s.res);
    await open();
    const line = () => panel().querySelector("[data-steps] button")!.textContent!.trim();
    expect(line()).toBe("Working…");
    expect(button("Stop")).toBeTruthy();
    expect(button("Send")).toBeUndefined();
    await s.write({ type: "reasoning", id: "r1", text: "Looking." });
    expect(line()).toBe("Thinking…");
    await s.write({ type: "tool_start", id: "s1", tool: "list_my_apps", label: "Read apps and their stages", args: "" });
    expect(line()).toBe("Reading apps and their stages…");
    expect(panel().querySelector("[data-steps] [data-slot=spinner]")).not.toBeNull();
    await s.write({ type: "tool_end", id: "s1", ok: true, ms: 5, summary: "1 app", result: "[]" }, { type: "delta", text: "You have " });
    expect(line()).toBe("Writing the answer…");
    const answer = panel().querySelector("[data-answer]")!;
    expect(answer.getAttribute("aria-live")).toBe("polite");
    expect(answer.getAttribute("aria-busy")).toBe("true");
    expect(answer.lastElementChild!.outerHTML).toBe('<span class="bg-primary inline-block h-4 w-1.5 animate-pulse rounded-sm" aria-hidden="true"></span>');
    // Enter asks nothing while an answer is coming.
    await typeIn("And which builds failed?");
    await press({ key: "Enter" });
    expect(asked).toHaveLength(1);
    await act(async () => {
      fireEvent.click(button("Stop")!);
    });
    await act(async () => undefined);
    expect(button("Stop")).toBeUndefined();
    expect(button("Send")).toBeTruthy();
    expect(panel().querySelector("[data-answer]")!.textContent).toBe("You haveStopped.");
    expect(line()).toBe("Used 1 read");
    // A stopped answer isn't part of what a follow-up carries.
    await press({ key: "Enter" });
    expect(asked[1].body).toEqual({ question: "And which builds failed?", history: [] });
  });

  it("New chat clears the conversation; it's off when there is none", async () => {
    stub(() => sse(ANSWER));
    await open();
    expect(button("New chat")!.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(button("New chat")!);
    });
    expect(panel().querySelectorAll("[data-turn]")).toHaveLength(0);
    expect(panel().querySelector("[data-ask-messages]")!.textContent).toBe("Ask about your apps, builds, members, licences or the audit trail.");
    expect(button("New chat")!.disabled).toBe(true);
    await typeIn("Which builds failed this week?");
    await press({ key: "Enter" });
    expect(asked[1].body).toEqual({ question: "Which builds failed this week?", history: [] });
  });

  it("Copy answer copies the answer's text; Ask again asks the question once more, in its place", async () => {
    const copied: string[] = [];
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async (t: string) => void copied.push(t) } });
    stub(() => sse(ANSWER));
    await open();
    await act(async () => {
      fireEvent.click(button("Copy answer")!);
    });
    await act(async () => undefined);
    expect(copied).toEqual([TEXT]);
    expect(button("Copied")).toBeTruthy();
    await act(async () => {
      fireEvent.click(button("Ask again")!);
    });
    await act(async () => undefined);
    await act(async () => undefined);
    expect(asked.map((a) => a.body)).toEqual([{ question: "Which apps do I have?", history: [] }, { question: "Which apps do I have?", history: [] }]);
    expect(panel().querySelectorAll("[data-turn]")).toHaveLength(1);
  });

  it("the messages follow the answer; once the reader scrolls up, Jump to latest brings them back", async () => {
    stub(() => sse(ANSWER));
    await open();
    const scroller = panel().querySelector("[data-ask-messages]") as HTMLDivElement;
    expect(button("Jump to latest")).toBeUndefined();
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    scroller.scrollTop = 300;
    await act(async () => {
      fireEvent.scroll(scroller);
    });
    expect(button("Jump to latest")).toBeTruthy();
    await act(async () => {
      fireEvent.click(button("Jump to latest")!);
    });
    expect(scroller.scrollTop).toBe(2000);
    expect(button("Jump to latest")).toBeUndefined();
    // At the foot, a new question keeps it there.
    await typeIn("What stage is it in?");
    await press({ key: "Enter" });
    expect(scroller.scrollTop).toBe(2000);
  });

  it("says when some statements have no source, why there is no answer, and shows a refusal as a sentence", async () => {
    stub(() => sse([{ type: "done", answer: "You have one app, and it is doing very well.", covered: true, model: "m", reason: null, uncited: true }]));
    await open();
    expect(panel().querySelector("[data-uncited]")!.textContent).toBe("Some statements have no source.");
    cleanup();
    stub(() => json({ answer: null, covered: null, sources: [], model: null, reason: "rate_limited" }));
    await open();
    expect(panel().querySelector("[data-turn]")!.textContent).toContain("That was a lot of questions in an hour.");
    cleanup();
    stub(() => sse([{ type: "sources", sources: SOURCES }, { type: "done", answer: null, covered: null, model: null, reason: "unavailable" }]));
    await open();
    expect(panel().querySelector("[data-turn]")!.textContent).toContain("Ask AI couldn't answer just now. Please ask again.");
    expect(panel().querySelector("[data-sources]")).toBeNull();
    cleanup();
    stub(() => json({ error: "busy", message: "Ask AI is still answering your last question." }, 429));
    await open();
    expect(panel().querySelector("[role=alert]")!.outerHTML).toBe('<p class="text-destructive text-sm" role="alert">Ask AI is still answering your last question.</p>');
    expect(button("Ask again")).toBeTruthy();
  });

  it("the platform admin's asks its own route, in its own words", async () => {
    stub(() => sse([{ type: "sources", sources: [{ n: 1, title: "Regulated firms › Atlas Trust Bank › Licences", href: "/platform/firms?tab=licences", tool: "list_license_reviews", readAt: at }] }, { type: "done", answer: "One firm is waiting [1].", covered: true, model: "m", reason: null }]));
    await open("admin", "Which regulated firms are waiting on a licence review?");
    expect(asked).toEqual([{ url: "/api/admin/ask", body: { question: "Which regulated firms are waiting on a licence review?", history: [] } }]);
    expect(field().placeholder).toBe("Ask about Mynt");
    expect(panel().textContent).toContain("AI summary from Mynt's data — may be imperfect (m).");
    expect([...panel().querySelectorAll("[data-turn] a")].map((a) => a.getAttribute("href"))).toEqual(["/platform/firms?tab=licences", "/platform/firms?tab=licences"]);
  });

  it("a link out of Studio in an answer is its text only", async () => {
    stub(() => sse([{ type: "done", answer: "See [the site](https://evil.example/x) and ![pic](https://evil.example/p.png).", covered: true, model: "m", reason: null }]));
    await open();
    expect(panel().querySelectorAll("[data-turn] a, img")).toHaveLength(0);
    expect(panel().innerHTML).not.toContain("evil.example");
    expect(AskAiDialog).toBeTypeOf("function");
  });

  it("one event at a time: a turn takes the stream as it comes", () => {
    const start = { id: 1, question: "q", text: "", steps: [], sources: [], done: null, error: null, stopped: false, streaming: true };
    const end = (ANSWER as Parameters<typeof applyEvent>[1][]).reduce(applyEvent, start);
    expect(end.streaming).toBe(false);
    expect(end.text).toBe(TEXT);
    expect(end.steps.map((s) => [s.kind, s.id])).toEqual([["reasoning", "r1"], ["tool", "s1"], ["tool", "s2"]]);
    expect(end.done).toMatchObject({ answer: TEXT, model: "claude-opus-5-5", thoughtMs: 6200, sources: SOURCES });
    expect(stepsLine(end)).toBe("Used 2 reads · Thought for 6s");
    expect(historyOf([end, { ...start, id: 2 }])).toEqual([{ role: "user", text: "q" }, { role: "assistant", text: TEXT }]);
  });
});
