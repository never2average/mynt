// What each docs address shows (lib/docs.ts docsRoute), on the server: a Markdown page (with the generated tables
// some pages carry: roles, first steps, runtime endpoints), Connect your agent, or the tool reference.
import Link from "next/link";

import { ConnectGuide } from "@/components/connect-guide";
import { CONNECT_SECTIONS } from "@/lib/connect-sections";
import { DocsArticle } from "@/components/docs/docs-article";
import { DocsMarkdown } from "@/components/docs/docs-markdown";
import { AllTools, AreaTools, LinkedText } from "@/components/docs/tool-reference";
import type { OnThisPageItem } from "@/components/docs/on-this-page";
import {
  CATALOGUE,
  ROLE_LABEL,
  TOOL_LINKS,
  TOOLS_HREF,
  breadcrumbs,
  docsTitle,
  markdownHeadings,
  neighbours,
  pageHref,
  toolsInArea,
  type DocsRoute,
} from "@/lib/docs";

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="mt-10 scroll-mt-6 border-b pb-2 font-heading text-xl font-semibold first:mt-0" data-docs-heading>
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
    <div className="mt-4 overflow-x-auto rounded-lg border">
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
    <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed" data-steps={role}>
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
    <div className="mt-4 overflow-x-auto rounded-lg border">
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

// A page's title, its "On this page" and its content.
export function docsPageParts(route: DocsRoute): { title: string; toc: OnThisPageItem[]; body: React.ReactNode } {
  if (route.kind === "tools") {
    return { title: docsTitle(route), toc: CATALOGUE.areas.map((a) => ({ id: a.id, label: a.title })), body: <AllTools /> };
  }
  if (route.kind === "area") {
    return { title: route.area.title, toc: toolsInArea(route.area.id).map((t) => ({ id: t.name, label: t.name })), body: <AreaTools area={route.area} /> };
  }
  const { page } = route;
  const md = page.markdown ? <DocsMarkdown source={page.markdown} toolLinks={TOOL_LINKS} /> : null;
  const headings = markdownHeadings(page.markdown);
  switch (page.kind) {
    case "connect":
      return {
        title: page.title,
        toc: [...CONNECT_SECTIONS],
        body: (
          <div className="flex flex-col gap-4 lg:gap-5" data-docs-connect>
            <ConnectGuide />
          </div>
        ),
      };
    case "roles":
      return {
        title: page.title,
        toc: [{ id: "roles", label: "Roles" }, ...headings],
        body: (
          <>
            <H2 id="roles">Roles</H2>
            <p className="mt-4 text-sm leading-relaxed">
              You sign in with OAuth from any MCP client (see <Link href={pageHref("connect")} className="font-medium text-link underline underline-offset-4">Connect your agent</Link>), and Mynt registers only the tools your roles allow. Roles nest: admin holds every role, and innovator and developer are two names for the builder role.
            </p>
            <RolesTable />
            {md}
          </>
        ),
      };
    case "first-app":
      return {
        title: page.title,
        toc: [{ id: "steps", label: "First steps" }, ...headings],
        body: (
          <>
            <H2 id="steps">First steps</H2>
            <p className="mt-4 text-sm leading-relaxed">To compose a product:</p>
            <Steps role="innovator" />
            <p className="mt-4 text-sm leading-relaxed">To build an app on one:</p>
            <Steps role="developer" />
            {md}
          </>
        ),
      };
    case "runtime":
      return {
        title: page.title,
        toc: [{ id: "endpoints", label: "Endpoints" }, ...headings],
        body: (
          <>
            <H2 id="endpoints">Endpoints</H2>
            <Endpoints />
            {md}
          </>
        ),
      };
    default:
      if (page.slug === "") {
        return {
          title: page.title,
          toc: [{ id: "start-here", label: "Start here" }, ...headings],
          body: (
            <>
              <H2 id="start-here">Start here</H2>
              <div className="mt-4 grid gap-3 sm:grid-cols-2" data-start-here>
                {START_HERE.map((s) => (
                  <Link key={s.href} href={s.href} className="rounded-lg border p-3 text-sm font-medium hover:bg-muted">
                    {s.title}
                  </Link>
                ))}
              </div>
              {md}
            </>
          ),
        };
      }
      return { title: page.title, toc: headings, body: md };
  }
}

export function DocsPage({ route }: { route: DocsRoute }) {
  const { title, toc, body } = docsPageParts(route);
  const { prev, next } = neighbours(route.href);
  return (
    <DocsArticle title={title} crumbs={breadcrumbs(route.href)} toc={toc} prev={prev} next={next}>
      {body}
    </DocsArticle>
  );
}
