// @vitest-environment jsdom
// The docs site (/docs), on Fumadocs: public, its nav tree (Fumadocs' source from core's generated data), the tool
// reference, search (Fumadocs' index, served by the app), /connect inside the docs' layout, and the Docs links in
// the studio.
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pushed: [] as string[], pathname: "/docs" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useParams: () => ({}),
  useRouter: () => ({ push: (h: string) => nav.pushed.push(h), replace: () => undefined, prefetch: () => undefined, back: () => undefined, refresh: () => undefined }),
  notFound: () => {
    throw new Error("not found");
  },
}));

// The visitor's session, as app/docs/layout.tsx reads it.
const signIn = vi.hoisted(() => ({ session: undefined as { tokens?: object } | undefined }));
vi.mock("@/lib/session", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/session")>()), currentSession: async () => signIn.session }));

const docs = await import("@/lib/docs");
const { source, allDocsSlugs } = await import("@/lib/docs-source");
const { docsPageParts, DocsPage } = await import("@/components/docs/docs-page");
const { DocsFrame } = await import("@/components/docs/docs-frame");
const { findNeighbour, flattenTree } = await import("fumadocs-core/page-tree");
const { getBreadcrumbItems } = await import("fumadocs-core/breadcrumb");
const { exampleCall, exampleValue, inputRows } = await import("@/lib/docs-schema");
const { pageNeedsSignIn } = await import("@/lib/page-gate");
const { TooltipProvider } = await import("@/components/ui/tooltip");

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

// A docs page as the app serves it: Fumadocs' layout around the page.
const served = (slug: string[]) => {
  const route = docs.docsRoute(slug)!;
  return renderToStaticMarkup(
    <DocsFrame>
      <DocsPage route={route} />
    </DocsFrame>,
  );
};
const dom = (html: string) => {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
};

describe("the docs' data", () => {
  it("documents every tool of core's catalogue, each in exactly one area", () => {
    const { tools, areas } = docs.CATALOGUE;
    expect(tools.length).toBeGreaterThan(300);
    expect(areas.reduce((n, a) => n + a.tools, 0)).toBe(tools.length);
    for (const a of areas) expect(docs.toolsInArea(a.id).length).toBe(a.tools);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });
});

describe("the nav tree (Fumadocs' source)", () => {
  it("has every section, every page and every tool area, in order, with previous, next and breadcrumbs", () => {
    const tree = source.pageTree;
    expect(tree.children.map((c) => (c.type === "folder" ? c.name : null))).toEqual(["Getting started", "Concepts", "Tool reference", "Guides"]);
    const urls = flattenTree(tree.children).map((p) => p.url);
    for (const a of docs.CATALOGUE.areas) expect(urls).toContain(`/docs/tools/${a.id}`);
    for (const href of ["/docs", "/connect", "/docs/roles", "/docs/first-app", "/docs/concepts/products", "/docs/tools", "/docs/guides/partners"]) expect(urls).toContain(href);
    expect(urls.length).toBe(allDocsSlugs().length);
    expect(findNeighbour(tree, "/docs").previous).toBeUndefined();
    expect(findNeighbour(tree, "/docs").next?.url).toBe("/connect");
    expect(findNeighbour(tree, "/docs/tools").next?.url).toBe(`/docs/tools/${docs.CATALOGUE.areas[0].id}`);
    expect(getBreadcrumbItems("/docs/tools/hosting", tree, { includePage: true }).map((c) => c.name)).toEqual(["Tool reference", "Hosting"]);
  });

  it("is the sidebar of every page, the page being read marked, with Open Studio linking back to the studio", () => {
    nav.pathname = "/docs/tools/hosting";
    const el = dom(served(["tools", "hosting"]));
    const sidebar = el.querySelector("#nd-sidebar")!;
    expect(sidebar).not.toBeNull();
    const links = [...sidebar.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
    for (const a of docs.CATALOGUE.areas) expect(links).toContain(`/docs/tools/${a.id}`);
    expect(links).toContain("/connect");
    expect(sidebar.querySelector('a[href="/docs/tools/hosting"]')!.getAttribute("data-active")).toBe("true");
    const studio = [...el.querySelectorAll('a[href="/"]')].find((a) => a.textContent === "Open Studio");
    expect(studio).toBeDefined();
    // Breadcrumbs and previous / next from the tree.
    expect(el.textContent).toContain("Tool reference");
    const hrefs = [...el.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
    const { previous, next } = findNeighbour(source.pageTree, "/docs/tools/hosting");
    expect(hrefs).toContain(previous!.url);
    expect(hrefs).toContain(next!.url);
    nav.pathname = "/docs";
  }, 30_000);
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

describe("every page", () => {
  it("renders in Fumadocs' layout, with its title and the ids its table of contents links to", () => {
    for (const slug of allDocsSlugs()) {
      const route = docs.docsRoute(slug)!;
      expect(route, slug.join("/")).not.toBeNull();
      const { toc } = docsPageParts(route);
      const html = served(slug);
      expect(html).toContain('id="nd-docs-layout"');
      const title = dom(html).querySelector("h1[data-docs-title]");
      expect(title?.textContent, slug.join("/")).toBe(docs.docsTitle(route));
      for (const t of toc) {
        expect(html.includes(`id="${t.id}"`), `${slug.join("/")}#${t.id}`).toBe(true);
        expect(html.includes(`href="#${t.id}"`), `toc ${slug.join("/")}#${t.id}`).toBe(true);
      }
    }
  }, 120_000);

  it("links a tool named in code to its reference, and the roles page lists every role", () => {
    const el = dom(renderToStaticMarkup(<>{docsPageParts(docs.docsRoute(["roles"])!).body}</>));
    expect([...el.querySelectorAll("[data-role-row]")].map((r) => r.getAttribute("data-role-row"))).toEqual(docs.CATALOGUE.roles.map((r) => r.role));
    el.innerHTML = renderToStaticMarkup(<>{docsPageParts(docs.docsRoute(["concepts", "workspaces"])!).body}</>);
    expect(el.querySelector('[data-tool-link="list_workspaces"]')!.getAttribute("href")).toBe(docs.TOOL_LINKS.list_workspaces);
  });
});

describe("Connect your agent", () => {
  it("is served at /connect inside the docs' layout, with the agent picker; /docs/connect redirects there", async () => {
    nav.pathname = "/connect";
    const el = dom(served(["connect"]));
    expect(el.querySelector("#nd-docs-layout [data-docs-connect]")).not.toBeNull();
    expect(el.querySelector('[data-docs-section="connect"]')).not.toBeNull();
    expect(el.querySelector("#nd-sidebar a[href=\"/connect\"]")!.getAttribute("data-active")).toBe("true");
    nav.pathname = "/docs";
    const { STUDIO_REDIRECTS, STUDIO_REWRITES } = await import("@/lib/redirects");
    expect(STUDIO_REWRITES).toContainEqual({ source: "/connect", destination: "/docs/connect" });
    expect(STUDIO_REDIRECTS).toContainEqual({ source: "/docs/connect", destination: "/connect", permanent: false });
  }, 30_000);
});

describe("signed in, the docs are inside the studio's shell", () => {
  // A docs page as a visitor gets it: app/docs/layout.tsx picks the layout from the session.
  const visit = async (slug: string[], session: { tokens?: object } | undefined) => {
    signIn.session = session;
    const { default: Layout } = await import("@/app/docs/layout");
    const tree = await Layout({ children: <DocsPage route={docs.docsRoute(slug)!} /> });
    return dom(renderToStaticMarkup(<TooltipProvider>{tree}</TooltipProvider>));
  };

  it("has the studio's sidebar and header, with Fumadocs' tree, search and contents in the content pane", async () => {
    nav.pathname = "/docs/tools/hosting";
    const el = await visit(["tools", "hosting"], { tokens: {} });
    // The studio's sidebar (the app's nav) and header, titled Docs, with its Docs button shown as current.
    const sidebar = el.querySelector('[data-slot="sidebar"]')!;
    expect(sidebar).not.toBeNull();
    expect(sidebar.querySelector("#nd-docs-layout")).toBeNull();
    const header = el.querySelector("[data-site-header]")!;
    expect(header.querySelector("h1")!.textContent).toBe("Docs");
    expect(header.querySelector("[data-docs-open]")!.getAttribute("data-active")).toBe("true");
    // Nothing in the studio's sidebar is the current page.
    expect(sidebar.querySelector('[data-active="true"]')).toBeNull();
    // Fumadocs' layout in the content pane, which scrolls it: its tree (the page marked), search and contents.
    const pane = el.querySelector('[data-slot="sidebar-inset"] [data-docs-in-shell]')!;
    expect(pane.className).toContain("overflow-y-auto");
    const tree = pane.querySelector("#nd-docs-layout #nd-sidebar")!;
    expect(tree.querySelector('a[href="/docs/tools/hosting"]')!.getAttribute("data-active")).toBe("true");
    expect(pane.querySelector("[data-search-full]")).not.toBeNull();
    expect(pane.querySelector("h1[data-docs-title]")!.textContent).toBe("Hosting");
    // The studio is already open, so no Open Studio link, and the theme switch is the header's.
    expect([...el.querySelectorAll("a")].some((a) => a.textContent === "Open Studio")).toBe(false);
    nav.pathname = "/docs";
  }, 30_000);

  it("and /connect too; signed out (or a session without a sign-in), the standalone public layout", async () => {
    nav.pathname = "/connect";
    const inShell = await visit(["connect"], { tokens: {} });
    expect(inShell.querySelector("[data-site-header] h1")!.textContent).toBe("Docs");
    expect(inShell.querySelector("[data-docs-in-shell] #nd-docs-layout [data-docs-connect]")).not.toBeNull();
    for (const session of [undefined, {}]) {
      const el = await visit(["connect"], session);
      expect(el.querySelector("[data-site-header]")).toBeNull();
      expect(el.querySelector('[data-slot="sidebar"]')).toBeNull();
      expect(el.querySelector("[data-docs-in-shell]")).toBeNull();
      expect(el.querySelector("#nd-docs-layout [data-docs-connect]")).not.toBeNull();
      expect(el.querySelector('#nd-sidebar a[href="/connect"]')!.getAttribute("data-active")).toBe("true");
      expect([...el.querySelectorAll('a[href="/"]')].some((a) => a.textContent === "Open Studio")).toBe(true);
    }
    nav.pathname = "/docs";
  }, 30_000);
});

describe("search (Fumadocs' index, served by the app)", () => {
  const search = async (q: string) => {
    const { GET } = await import("@/app/docs/search-index/route");
    const res = await GET(new Request(`https://studio.example.com/docs/search-index?query=${encodeURIComponent(q)}`));
    expect(res.status).toBe(200);
    return (await res.json()) as { type: string; url: string; content: string }[];
  };

  it("finds a tool by its name or its words, and a page by its title", async () => {
    const hits = await search("define_region");
    expect(hits.some((h) => h.url === "/docs/tools/admin#define_region")).toBe(true);
    expect((await search("define region")).some((h) => h.url === "/docs/tools/admin#define_region")).toBe(true);
    expect((await search("start_build")).some((h) => h.url === docs.TOOL_LINKS.start_build)).toBe(true);
    expect((await search("connect your agent"))[0]).toMatchObject({ type: "page", url: "/connect" });
    expect(await search("zzzzqqqq")).toEqual([]);
  });

  it("is the layout's search, asking /docs/search-index", async () => {
    const { DOCS_SEARCH_API } = await import("@/components/docs/docs-frame");
    expect(DOCS_SEARCH_API).toBe("/docs/search-index");
    expect(pageNeedsSignIn(DOCS_SEARCH_API)).toBe(false);
    const el = dom(served([]));
    // Fumadocs' search box in the sidebar, labelled with its words (it opens Fumadocs' search dialog).
    expect(el.querySelector("[data-search-full]")!.textContent).toMatch(/Search/);
  }, 30_000);
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
      // Docs isn't in the sidebar (the header's Docs button opens it).
      expect(html).not.toContain("data-docs-link-sidebar");
      expect(html).not.toMatch(/href="\/docs"/);
    }
    const { DocsButton } = await import("@/components/connect-agent");
    render(<DocsButton />);
    const link = document.querySelector("[data-docs-open]")!;
    expect(link.getAttribute("href")).toBe("/docs");
    expect(link.textContent).toBe("Docs");
  }, 30_000);
});
