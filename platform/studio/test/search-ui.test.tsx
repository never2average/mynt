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
const { AskAiDialog, AskAiProvider, askAction, forgetAnswers, useAskAi } = await import("@/components/kbar/ask-ai");
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
  forgetAnswers();
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
    "<DialogContent className='max-h-[85svh] gap-0 overflow-y-auto p-0 sm:max-w-xl'",
    "<DialogHeader className='border-b p-4 pr-12'>",
    "<DialogTitle className='flex items-center gap-2'><IconSparkles className='text-primary size-4' /> Ask AI</DialogTitle>",
    "<form className='mt-2'",
    "aria-label='Your question' maxLength={400}",
    "<div className='flex flex-col gap-4 p-4' onClick={onLinkClick}>",
    "<p className='text-destructive text-sm'>{error}</p>",
    "<div className='flex flex-col gap-2' aria-live='polite' aria-busy={streaming}>",
    "<Markdown className='max-w-none text-sm [&_a]:no-underline [&_p]:my-2 [&_p]:leading-6 [&_ul]:my-2'>{linked(text, sources)}</Markdown>",
    "<span className='bg-primary inline-block h-4 w-1.5 animate-pulse rounded-sm' aria-hidden />",
    "<p className='text-muted-foreground text-xs'>",
    "<div className='text-muted-foreground flex items-center gap-2 py-6 text-sm' role='status'><Spinner className='size-4' />",
    "<p className='text-muted-foreground text-sm'>",
    "<div className='flex flex-col gap-2 border-t pt-3'>",
    "<span className='text-muted-foreground text-xs font-medium tracking-wider uppercase'>Sources</span>",
    "<ol className='flex flex-col gap-1'>",
    "<li key={s.n} className='flex gap-2 text-sm'>",
    "<span className='text-muted-foreground w-5 shrink-0 text-right tabular-nums'>{s.n}.</span>",
    "<Link href={s.href} className='hover:text-primary min-w-0 transition-colors'>",
    "{s.title}{s.heading && <span className='text-muted-foreground'> › {s.heading}</span>}",
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
    expect(a).toMatchObject({ id: "ask-ai", name: "Ask AI: which apps are live", keywords: "which apps are live", priority: 10, section: { name: "Ask AI", priority: 10 }, subtitle: "A short answer from Mynt's data, with its sources" });
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
          { type: "sources", sources: [{ n: 1, title: "Regulated firms", heading: "Licences", href: "/platform/firms?tab=licences" }] },
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
    expect(calls.filter((c) => c.body)).toEqual([{ url: "/api/admin/ask", body: { question } }]);
    expect(calls.some((c) => c.url === "/api/ask" || c.url.startsWith("/api/workspaces") || c.url.startsWith("/api/projects"))).toBe(false);
    const dialog = document.querySelector("[data-slot=dialog-content]")!;
    expect(dialog.textContent).toContain("Atlas Trust Bank is waiting on a licence review [1].");
    expect(dialog.textContent).toContain("AI summary from Mynt's data — may be imperfect (claude-opus-5-5).");
    expect([...dialog.querySelectorAll("ol a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["Regulated firms › Licences", "/platform/firms?tab=licences"]]);
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
    expect(by("page:/licences")).toMatchObject({ name: "Licences", section: { name: "Pages", priority: 5 }, subtitle: "Go to Licences", href: "/licences" });
    expect(by("app:a2")).toMatchObject({ name: "Budgeting", section: { name: "Apps", priority: 4 }, subtitle: "Staging", href: "/a2" });
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

// ---------- the Ask AI dialog ----------

describe("the Ask AI dialog", () => {
  const SOURCES = [
    { n: 1, title: "Dashboard", heading: "Apps", href: "/" },
    { n: 2, title: "Licences", heading: null, href: "/licences" },
  ];
  const ANSWER = [
    { type: "delta", text: "Let me look." },
    { type: "reset" },
    { type: "sources", sources: SOURCES },
    { type: "delta", text: "You have one app, Round-up savings [1]. Its licence is verified [2][9]." },
    { type: "done", answer: "You have one app, Round-up savings [1]. Its licence is verified [2][9].", covered: true, model: "claude-opus-5-5", reason: null },
  ];
  let asked: { url: string; body: unknown }[] = [];
  const stub = (reply: () => Response) =>
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      asked.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return reply();
    });
  function Opener({ question }: { question: string }) {
    const ask = useAskAi();
    return (
      <button type="button" onClick={() => ask(question)}>
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
      fireEvent.click(document.querySelector("button")!);
    });
    await act(async () => undefined);
    await act(async () => undefined);
  };
  const dialog = () => document.querySelector("[data-slot=dialog-content]")!;
  beforeEach(() => {
    asked = [];
  });

  it("its markup: the panel, the header with the question, the answer, its note and its sources", async () => {
    stub(() => sse(ANSWER));
    await open();
    expect(asked).toEqual([{ url: "/api/ask", body: { question: "Which apps do I have?" } }]);
    const d = dialog();
    for (const c of ["search-port", "fixed", "top-1/2", "left-1/2", "z-50", "grid", "rounded-xl", "bg-popover", "text-popover-foreground", "ring-1", "ring-foreground/10", "duration-100", "max-h-[85svh]", "gap-0", "overflow-y-auto", "p-0", "sm:max-w-xl"])
      expect(classOf(d)!.split(" "), c).toContain(c);
    const overlay = document.querySelector("[data-slot=dialog-overlay]")!;
    expect(classOf(overlay)).toContain("fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs");
    const header = d.querySelector("[data-slot=dialog-header]")!;
    expect(classOf(header)).toBe("flex flex-col gap-2 border-b p-4 pr-12");
    const title = d.querySelector("[data-slot=dialog-title]")!;
    expect(classOf(title)).toBe("text-base leading-none font-medium flex items-center gap-2");
    expect(title.textContent).toBe(" Ask AI");
    expect(classOf(title.querySelector("svg"))).toBe("tabler-icon tabler-icon-sparkles text-primary size-4");
    const input = d.querySelector("input[name=question]") as HTMLInputElement;
    expect(input.value).toBe("Which apps do I have?");
    expect(input.getAttribute("aria-label")).toBe("Your question");
    expect(input.maxLength).toBe(400);
    expect(input.placeholder).toBe("Ask a question about your Mynt data");
    expect(classOf(input.closest("form"))).toBe("mt-2");
    // The close control: an icon, named for a screen reader.
    const close = d.querySelector("[data-slot=dialog-close]")!;
    expect(close.textContent).toBe("Close");
    expect(classOf(close.querySelector("span"))).toBe("sr-only");
    for (const c of ["absolute", "top-2", "right-2", "size-7"]) expect(classOf(close)!.split(" "), c).toContain(c);

    const body = header.nextElementSibling!;
    expect(classOf(body)).toBe("flex flex-col gap-4 p-4");
    const answer = body.firstElementChild!;
    expect(classOf(answer)).toBe("flex flex-col gap-2");
    expect(answer.getAttribute("aria-live")).toBe("polite");
    for (const c of ["text-foreground", "break-words", "max-w-none", "text-sm", "[&_a]:no-underline", "[&_p]:my-2", "[&_p]:leading-6", "[&_ul]:my-2"]) expect(classOf(answer.firstElementChild)!.split(" "), c).toContain(c);
    // What was written before the read was dropped; citations of real sources are links to their pages.
    expect(answer.firstElementChild!.textContent).toBe("You have one app, Round-up savings [1]. Its licence is verified [2][9].");
    const cites = [...answer.firstElementChild!.querySelectorAll("a")];
    expect(cites.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["[1]", "/"], ["[2]", "/licences"]]);
    expect(classOf(cites[0])).toBe("text-primary decoration-primary/40 hover:decoration-primary font-medium underline underline-offset-4 transition-colors");
    const note = answer.lastElementChild!;
    expect(classOf(note)).toBe("text-muted-foreground text-xs");
    expect(note.textContent).toBe("AI summary from your Mynt data — may be imperfect (claude-opus-5-5).");

    const sources = body.lastElementChild!;
    expect(classOf(sources)).toBe("flex flex-col gap-2 border-t pt-3");
    expect(sources.firstElementChild!.outerHTML).toBe('<span class="text-muted-foreground text-xs font-medium tracking-wider uppercase">Sources</span>');
    expect(classOf(sources.querySelector("ol"))).toBe("flex flex-col gap-1");
    expect(sources.querySelector("li")!.outerHTML).toBe(
      '<li class="flex gap-2 text-sm"><span class="text-muted-foreground w-5 shrink-0 text-right tabular-nums">1.</span><a class="hover:text-primary min-w-0 transition-colors" href="/">Dashboard<span class="text-muted-foreground"> › Apps</span></a></li>',
    );
    expect([...sources.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Dashboard › Apps", "Licences"]);
  });

  it("while it reads: a spinner and what it's doing; while it writes: a pulsing cursor", async () => {
    let finish: () => void = () => undefined;
    const encoder = new TextEncoder();
    stub(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              finish = () => {
                c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "delta", text: "You have " })}\n\n`));
              };
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    await open();
    const body = dialog().querySelector("[data-slot=dialog-header]")!.nextElementSibling!;
    const reading = body.firstElementChild!;
    expect(classOf(reading)).toBe("text-muted-foreground flex items-center gap-2 py-6 text-sm");
    expect(reading.getAttribute("role")).toBe("status");
    expect(reading.textContent).toBe(" Reading your Mynt data…");
    expect(classOf(reading.querySelector("svg"))).toBe("tabler-icon tabler-icon-loader animate-spin size-4");
    await act(async () => {
      finish();
      await new Promise((r) => setTimeout(r, 10));
    });
    const cursor = body.firstElementChild!.lastElementChild!;
    expect(cursor.outerHTML).toBe('<span class="bg-primary inline-block h-4 w-1.5 animate-pulse rounded-sm" aria-hidden="true"></span>');
    expect(body.firstElementChild!.getAttribute("aria-busy")).toBe("true");
  });

  it("a citation or a source closes the dialog as its page opens", async () => {
    stub(() => sse(ANSWER));
    await open();
    const source = [...dialog().querySelectorAll("ol a")][1] as HTMLAnchorElement;
    source.addEventListener("click", (e) => e.preventDefault()); // jsdom doesn't navigate
    await act(async () => {
      fireEvent.click(source);
    });
    expect(document.querySelector("[data-slot=dialog-content]")).toBeNull();
  });

  it("the question can be edited and asked again; one already answered is shown without asking twice", async () => {
    stub(() => sse(ANSWER));
    await open();
    const ask = async (q: string) => {
      const input = dialog().querySelector("input[name=question]") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(input, { target: { value: q } });
        fireEvent.submit(input.closest("form")!);
      });
      await act(async () => undefined);
      await act(async () => undefined);
    };
    await ask("And which builds failed?");
    expect(asked.map((a) => a.body)).toEqual([{ question: "Which apps do I have?" }, { question: "And which builds failed?" }]);
    await ask("Which apps do I have?");
    expect(asked).toHaveLength(2);
    expect(dialog().textContent).toContain("Round-up savings");
    // Too short to be a question: nothing is asked.
    await ask("hi");
    expect(asked).toHaveLength(2);
  });

  it("says why when there is no AI summary, and shows a refusal as a sentence", async () => {
    stub(() => json({ answer: null, covered: null, sources: [], model: null, reason: "rate_limited" }));
    await open();
    const body = () => dialog().querySelector("[data-slot=dialog-header]")!.nextElementSibling!;
    expect(body().firstElementChild!.outerHTML).toMatch(/^<p class="text-muted-foreground text-sm">AI summary unavailable: that was a lot of questions in an hour/);
    cleanup();
    forgetAnswers();
    stub(() => sse([{ type: "sources", sources: SOURCES }, { type: "done", answer: null, covered: null, model: null, reason: "unavailable" }]));
    await open();
    expect(body().firstElementChild!.textContent).toMatch(/^AI summary unavailable\./);
    expect(dialog().querySelectorAll("ol a")).toHaveLength(2); // the sources it read still show
    cleanup();
    forgetAnswers();
    stub(() => json({ error: "busy", message: "Ask AI is still answering your last question." }, 429));
    await open();
    expect(body().firstElementChild!.outerHTML).toBe('<p class="text-destructive text-sm">Ask AI is still answering your last question.</p>');
  });

  it("the platform admin's asks its own route, in its own words", async () => {
    stub(() => sse([{ type: "sources", sources: [{ n: 1, title: "Regulated firms", heading: "Licences", href: "/platform/firms?tab=licences" }] }, { type: "done", answer: "One firm is waiting [1].", covered: true, model: "m", reason: null }]));
    await open("admin", "Which regulated firms are waiting on a licence review?");
    expect(asked).toEqual([{ url: "/api/admin/ask", body: { question: "Which regulated firms are waiting on a licence review?" } }]);
    expect((dialog().querySelector("input[name=question]") as HTMLInputElement).placeholder).toBe("Ask a question about Mynt");
    expect(dialog().textContent).toContain("AI summary from Mynt's data — may be imperfect (m).");
    expect([...dialog().querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["/platform/firms?tab=licences", "/platform/firms?tab=licences"]);
  });

  it("a link out of Studio in an answer is its text only", async () => {
    stub(() => sse([{ type: "done", answer: "See [the site](https://evil.example/x) and ![pic](https://evil.example/p.png).", covered: true, model: "m", reason: null }]));
    await open();
    expect(dialog().querySelectorAll("a, img")).toHaveLength(0);
    expect(dialog().innerHTML).not.toContain("evil.example");
    expect(AskAiDialog).toBeTypeOf("function");
  });
});
