// @vitest-environment jsdom
// The docs site (/docs): public, its nav tree, the tool reference from core's catalogue, search, and the Docs links
// in the studio.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pushed: [] as string[], pathname: "/docs" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: (h: string) => nav.pushed.push(h), replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
  notFound: () => {
    throw new Error("not found");
  },
}));

const docs = await import("@/lib/docs");
const { docsPageParts, DocsPage } = await import("@/components/docs/docs-page");
const { DocsNav, DocsShell } = await import("@/components/docs/docs-shell");
const { DocsSearch } = await import("@/components/docs/docs-search");
const { searchDocs } = await import("@/lib/docs-search");
const { exampleCall, exampleValue, inputRows } = await import("@/lib/docs-schema");
const { pageNeedsSignIn } = await import("@/lib/page-gate");
const { TooltipProvider } = await import("@/components/ui/tooltip");

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe("the docs' data", () => {
  it("documents every tool of core's catalogue, each in exactly one area", () => {
    const { tools, areas } = docs.CATALOGUE;
    expect(tools.length).toBeGreaterThan(300);
    expect(areas.reduce((n, a) => n + a.tools, 0)).toBe(tools.length);
    for (const a of areas) expect(docs.toolsInArea(a.id).length).toBe(a.tools);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });
});

describe("the nav tree", () => {
  it("has every section, every page and every tool area, in order, with previous and next between them", () => {
    const tree = docs.docsNav();
    expect(tree.map((s) => s.title)).toEqual(["Getting started", "Concepts", "Tool reference", "Guides"]);
    render(<DocsNav nav={tree} pathname="/docs/tools/hosting" />);
    const links = [...document.querySelectorAll("[data-nav-link]")].map((a) => a.getAttribute("href"));
    for (const a of docs.CATALOGUE.areas) expect(links).toContain(`/docs/tools/${a.id}`);
    for (const href of ["/docs", "/connect", "/docs/roles", "/docs/first-app", "/docs/concepts/products", "/docs/tools", "/docs/guides/partners"]) expect(links).toContain(href);
    expect(document.querySelector('[aria-current="page"]')!.getAttribute("href")).toBe("/docs/tools/hosting");
    expect(docs.neighbours("/docs").prev).toBeNull();
    expect(docs.neighbours("/docs").next?.href).toBe("/connect");
    expect(docs.neighbours("/docs/tools").next?.href).toBe(`/docs/tools/${docs.CATALOGUE.areas[0].id}`);
    expect(docs.breadcrumbs("/docs/tools/hosting").map((c) => c.title)).toEqual(["Docs", "Tool reference", "Hosting"]);
  });

  it("collapses a section", async () => {
    render(<DocsNav nav={docs.docsNav()} pathname="/docs" />);
    const section = document.querySelector('[data-nav-section="concepts"]')!;
    expect(section.querySelector("[data-nav-link]")).not.toBeNull();
    await act(async () => void fireEvent.click(section.querySelector("[data-nav-section-toggle]")!));
    expect(section.querySelector("[data-nav-link]")).toBeNull();
  });

  it("is in a sheet on a phone, opened by a labelled Menu button; the header links back to the studio", async () => {
    render(
      <TooltipProvider>
        <DocsShell nav={docs.docsNav()}>
          <p>page</p>
        </DocsShell>
      </TooltipProvider>,
    );
    const menu = document.querySelector("[data-docs-menu]")!;
    expect(menu.textContent).toBe("Menu");
    expect(document.querySelector("[data-docs-studio-link]")!.getAttribute("href")).toBe("/");
    await act(async () => void fireEvent.click(menu));
    expect(document.querySelector('[role="dialog"] [data-docs-nav]')).not.toBeNull();
  });
});

describe("a tool area's page", () => {
  it("shows each tool with its roles, access, inputs table, example call and related tools", () => {
    const route = docs.docsRoute(["tools", "admin"])!;
    const html = renderToStaticMarkup(<>{docsPageParts(route).body}</>);
    const el = document.createElement("div");
    el.innerHTML = html;
    const tool = el.querySelector('[data-tool="define_region"]')!;
    expect(tool.querySelector("h2")!.id).toBe("define_region");
    expect(tool.querySelector("[data-roles]")!.textContent).toBe("Admin");
    expect(tool.querySelector("[data-access]")!.textContent).toBe("Changes data");
    const rows = [...tool.querySelectorAll("[data-inputs-table] [data-input]")].map((r) => r.getAttribute("data-input"));
    expect(rows).toEqual(expect.arrayContaining(["code", "name", "regulators", "procedures", "procedures[].product_line"]));
    const code = tool.querySelector('[data-input="code"]')!;
    expect(code.textContent).toContain("Required");
    expect(code.textContent).toContain("pattern: ^(global|[A-Z]{2})$");
    expect(tool.querySelector('[data-input="procedures[].product_line"] [data-enum]')!.textContent).toContain("credit");
    const call = JSON.parse(tool.querySelector("[data-example-call]")!.textContent!);
    expect(call).toMatchObject({ jsonrpc: "2.0", method: "tools/call", params: { name: "define_region", arguments: { code: "US" } } });
    // Its row in the area's table, and the page's On this page lists every tool.
    expect(el.querySelector('[data-tool-table] [data-tool-row="define_region"] a')!.getAttribute("href")).toBe("/docs/tools/admin#define_region");
    expect(docsPageParts(route).toc.map((t) => t.id)).toEqual(docs.toolsInArea("admin").map((t) => t.name));
  });

  it("builds inputs and examples from any tool's JSON Schema", () => {
    for (const t of docs.CATALOGUE.tools) {
      const rows = inputRows(t.inputSchema);
      for (const name of t.inputSchema.required ?? []) expect(rows.find((r) => r.name === name)?.required, `${t.name}.${name}`).toBe(true);
      const args = exampleValue(t.inputSchema) as Record<string, unknown>;
      for (const name of t.inputSchema.required ?? []) expect(args, `${t.name}`).toHaveProperty(name);
      expect(() => JSON.parse(exampleCall(t.name, t.inputSchema))).not.toThrow();
    }
    const whoami = docs.toolByName("whoami")!;
    expect(inputRows(whoami.inputSchema)).toEqual([]);
    expect(renderToStaticMarkup(<>{docsPageParts(docs.docsRoute(["tools", "catalogue"])!).body}</>)).toContain("This tool takes no inputs.");
  });

  it("lists every tool on All tools, grouped by area, with what it does, its roles and whether it changes data", () => {
    const html = renderToStaticMarkup(<>{docsPageParts(docs.docsRoute(["tools"])!).body}</>);
    const el = document.createElement("div");
    el.innerHTML = html;
    expect(el.querySelectorAll("[data-area]").length).toBe(docs.CATALOGUE.areas.length);
    expect(el.querySelectorAll("[data-tool-row]").length).toBe(docs.CATALOGUE.tools.length);
    const row = el.querySelector('[data-tool-row="list_products"]')!;
    expect(row.querySelector("[data-access]")!.textContent).toBe("Read");
  });
});

describe("Markdown pages", () => {
  it("render every page, with On this page naming the ids its headings get", () => {
    for (const slug of docs.allDocsSlugs()) {
      const route = docs.docsRoute(slug)!;
      expect(route, slug.join("/")).not.toBeNull();
      const { toc } = docsPageParts(route);
      const html = renderToStaticMarkup(<DocsPage route={route} />);
      expect(html).toContain(`data-docs-title="true">${renderToStaticMarkup(<>{docs.docsTitle(route)}</>)}</h1>`);
      for (const t of toc) expect(html.includes(`id="${t.id}"`), `${slug.join("/")}#${t.id}`).toBe(true);
    }
  }, 60_000);

  it("link a tool named in code to its reference, and the roles page lists every role", () => {
    const el = document.createElement("div");
    el.innerHTML = renderToStaticMarkup(<>{docsPageParts(docs.docsRoute(["roles"])!).body}</>);
    expect([...el.querySelectorAll("[data-role-row]")].map((r) => r.getAttribute("data-role-row"))).toEqual(docs.CATALOGUE.roles.map((r) => r.role));
    el.innerHTML = renderToStaticMarkup(<>{docsPageParts(docs.docsRoute(["concepts", "workspaces"])!).body}</>);
    expect(el.querySelector('[data-tool-link="list_workspaces"]')!.getAttribute("href")).toBe(docs.TOOL_LINKS.list_workspaces);
  });
});

describe("search", () => {
  it("finds a tool by its name, its words or its title, and pages by title", () => {
    const index = docs.searchIndex();
    expect(searchDocs(index, "define_region")[0]).toMatchObject({ kind: "tool", title: "define_region", href: "/docs/tools/admin#define_region" });
    expect(searchDocs(index, "define region")[0].title).toBe("define_region");
    expect(searchDocs(index, "connect your agent")[0]).toMatchObject({ kind: "page", href: "/connect" });
    expect(searchDocs(index, "")).toEqual([]);
    expect(searchDocs(index, "zzzz-nothing")).toEqual([]);
  });

  it("is served as JSON, and the box shows results and goes to one", async () => {
    const { GET } = await import("@/app/docs/search-index/route");
    const body = (await GET().json()) as { items: { title: string }[] };
    expect(body.items.some((i) => i.title === "start_build")).toBe(true);
    render(<DocsSearch initialIndex={docs.searchIndex()} />);
    const input = document.querySelector("[data-docs-search-input]") as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "start_build" } });
    });
    const first = document.querySelector("[data-docs-result]")!;
    expect(first.getAttribute("data-docs-result")).toBe(docs.TOOL_LINKS.start_build);
    await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));
    expect(nav.pushed).toContain(docs.TOOL_LINKS.start_build);
  });
});

describe("public access", () => {
  it("needs no sign-in for /docs or any page under it", async () => {
    for (const p of ["/docs", "/docs/tools", "/docs/tools/hosting", "/docs/connect", "/connect", "/docs/search-index"]) expect(pageNeedsSignIn(p), p).toBe(false);
    expect(pageNeedsSignIn("/docsx")).toBe(true);
    expect(pageNeedsSignIn("/")).toBe(true);
    const { proxy } = await import("@/proxy");
    const req = (path: string) => new NextRequest(new URL(path, "https://studio.example.com"), { headers: { host: "studio.example.com" } });
    const open = await proxy(req("/docs/tools/hosting"));
    expect(open.status).toBe(200);
    expect(open.headers.get("location")).toBeNull();
    expect((await proxy(req("/licences"))).status).toBe(307);
  });
});

describe("Docs links in the studio", () => {
  it("are in the sidebar for everyone and in the header beside Connect your agent", async () => {
    const { SidebarView } = await import("@/components/app-sidebar");
    const { SidebarProvider } = await import("@/components/ui/sidebar");
    const { PERSONAL } = await import("@/lib/workspaces");
    for (const developer of [true, false]) {
      const html = renderToStaticMarkup(
        <TooltipProvider>
          <SidebarProvider>
            <SidebarView workspaces={[PERSONAL]} selected={PERSONAL} supported={false} groups={null} account={{ name: "Sam", email: null }} pathname="/" onSelectWorkspace={() => undefined} onCreateWorkspace={async () => null} developer={developer} />
          </SidebarProvider>
        </TooltipProvider>,
      );
      expect(html).toMatch(/href="\/docs"[^>]*data-docs-link-sidebar/);
    }
    const { DocsButton } = await import("@/components/connect-agent");
    render(<DocsButton />);
    const link = document.querySelector("[data-docs-open]")!;
    expect(link.getAttribute("href")).toBe("/docs");
    expect(link.textContent).toBe("Docs");
  }, 30_000);
});
