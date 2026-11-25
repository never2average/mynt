// What each docs address shows (lib/docs.ts docsRoute), on the server, inside Fumadocs' page (title, breadcrumbs,
// table of contents, previous and next): a Markdown page (with the generated tables some pages carry: roles, first
// steps, runtime endpoints), Connect your agent (the studio's guide, with its agent picker), or the tool reference.
// The Markdown is set by Fumadocs' typography (DocsBody); the studio's own blocks keep their styles (not-prose).
import Link from "next/link";
import { DocsBody, DocsPage as FumadocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { findNeighbour } from "fumadocs-core/page-tree";

import { ConnectGuide } from "@/components/connect-guide";
import { DocsMarkdown } from "@/components/docs/docs-markdown";
import { AllTools, AreaTools, LinkedText } from "@/components/docs/tool-reference";
import { CATALOGUE, ROLE_LABEL, TOOL_LINKS, TOOLS_HREF, docsSections, docsTitle, pageHref, type DocsHeading, type DocsRoute } from "@/lib/docs";
import { docsUrl, source } from "@/lib/docs-source";

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} data-docs-heading>
      {children}
    </h2>
  );
}

const ToolLink = ({ name }: { name: string }) => (
  <a href={TOOL_LINKS[name]} className="font-mono text-xs text-link hover:underline" data-tool-link={name}>
    {name}
  </a>
);

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-xs font-medium text-muted-foreground">{children}</th>;
}

function RolesTable() {
  return (
    <div className="not-prose mt-4 overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-sm" data-roles-table>
        <thead className="bg-muted/50">
          <tr className="border-b">
            <Th>Role</Th>
            <Th>Who</Th>
            <Th>Tools</Th>
            <Th>Start with</Th>
          </tr>
        </thead>
        <tbody>
          {CATALOGUE.roles.map((r) => (
            <tr key={r.role} className="border-b last:border-0" data-role-row={r.role}>
              <td className="px-3 py-2 align-top whitespace-nowrap">
                <span className="font-medium">{ROLE_LABEL[r.role]}</span>
                <span className="block font-mono text-xs text-muted-foreground">{r.role}</span>
              </td>
              <td className="px-3 py-2 align-top">
                <LinkedText text={r.summary} />
              </td>
              <td className="px-3 py-2 align-top tabular-nums">{r.tools}</td>
              <td className="px-3 py-2 align-top">
                <span className="flex flex-col gap-0.5">
                  {r.get_started.map((s) => (
                    <ToolLink key={s.tool} name={s.tool} />
                  ))}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Steps({ role }: { role: "innovator" | "developer" }) {
  const steps = CATALOGUE.roles.find((r) => r.role === role)?.get_started ?? [];
  return (
    <ol data-steps={role}>
      {steps.map((s) => (
        <li key={s.tool}>
          <ToolLink name={s.tool} />: <LinkedText text={s.why} />
        </li>
      ))}
    </ol>
  );
}

function Endpoints() {
  return (
    <div className="not-prose mt-4 overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-sm" data-endpoints-table>
        <thead className="bg-muted/50">
          <tr className="border-b">
            <Th>Endpoint</Th>
            <Th>Authenticates with</Th>
            <Th>What it does</Th>
          </tr>
        </thead>
        <tbody>
          {CATALOGUE.runtime_endpoints.map((e) => (
            <tr key={`${e.method} ${e.path}`} className="border-b last:border-0">
              <td className="px-3 py-2 align-top font-mono text-xs whitespace-nowrap">
                {e.method} {e.path}
              </td>
              <td className="px-3 py-2 align-top text-xs whitespace-nowrap">{e.auth === "app key" ? "App key (your server)" : "Client session (a device)"}</td>
              <td className="px-3 py-2 align-top">{e.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const START_HERE = [
  { title: "Connect your agent", href: pageHref("connect") },
  { title: "Authentication & roles", href: pageHref("roles") },
  { title: "Your first app", href: pageHref("first-app") },
  { title: "Tool reference", href: TOOLS_HREF },
];

function body(route: DocsRoute): React.ReactNode {
  if (route.kind === "tools") return <AllTools />;
  if (route.kind === "area") return <AreaTools area={route.area} />;
  const { page } = route;
  const md = page.markdown ? <DocsMarkdown source={page.markdown} toolLinks={TOOL_LINKS} /> : null;
  switch (page.kind) {
    case "connect":
      return (
        <div className="not-prose flex flex-col gap-4 lg:gap-5" data-docs-connect>
          <ConnectGuide />
        </div>
      );
    case "roles":
      return (
        <>
          <H2 id="roles">Roles</H2>
          <p>
            You sign in with OAuth from any MCP client (see <Link href={pageHref("connect")}>Connect your agent</Link>), and Mynt registers only the tools your roles allow. Roles nest: an admin also holds the builder, vendor and licence-provider roles, but not the liquidity-provider role, and innovator and developer are two names for the builder role.
          </p>
          <RolesTable />
          {md}
        </>
      );
    case "first-app":
      return (
        <>
          <H2 id="steps">First steps</H2>
          <p>To compose a product:</p>
          <Steps role="innovator" />
          <p>To build an app on one:</p>
          <Steps role="developer" />
          {md}
        </>
      );
    case "runtime":
      return (
        <>
          <H2 id="endpoints">Endpoints</H2>
          <Endpoints />
          {md}
        </>
      );
    default:
      if (page.slug !== "") return md;
      return (
        <>
          <H2 id="start-here">Start here</H2>
          <div className="not-prose mt-4 grid gap-3 sm:grid-cols-2" data-start-here>
            {START_HERE.map((s) => (
              <Link key={s.href} href={s.href} className="rounded-lg border p-3 text-sm font-medium hover:bg-muted">
                {s.title}
              </Link>
            ))}
          </div>
          {md}
        </>
      );
  }
}

// A page's title, its table of contents and its content.
export function docsPageParts(route: DocsRoute): { title: string; toc: DocsHeading[]; body: React.ReactNode } {
  return { title: docsTitle(route), toc: docsSections(route), body: body(route) };
}

const routeSlugs = (route: DocsRoute): string[] => (route.kind === "tools" ? ["tools"] : route.kind === "area" ? ["tools", route.area.id] : route.page.slug ? route.page.slug.split("/") : []);

export function DocsPage({ route }: { route: DocsRoute }) {
  const { title, toc, body } = docsPageParts(route);
  // Previous and next follow the nav tree, found by the page's own address (so /connect, served from /docs/connect,
  // gets its neighbours too).
  const { previous, next } = findNeighbour(source.pageTree, docsUrl(routeSlugs(route)));
  return (
    <FumadocsPage toc={toc.map((t) => ({ title: t.label, url: `#${t.id}`, depth: 2 }))} footer={{ items: { previous, next } }}>
      <DocsTitle data-docs-title>{title}</DocsTitle>
      <DocsBody data-docs-content>{body}</DocsBody>
    </FumadocsPage>
  );
}
