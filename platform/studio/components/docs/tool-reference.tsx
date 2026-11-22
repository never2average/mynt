// The tool reference (/docs/tools and /docs/tools/<area>), from the live registry's catalogue (lib/docs.ts): every
// tool grouped by area in tables, and each area's tools in full — description, roles, access, an inputs table from
// the tool's JSON Schema, an example call and related tools. Rendered on the server.
import { Fragment, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { ACCESS_LABEL, CATALOGUE, ROLE_LABEL, TOOL_LINKS, areaHref, relatedTools, toolHref, toolSummary, toolsInArea, type DocsArea, type DocsRole, type DocsTool } from "@/lib/docs";
import { exampleCall, inputRows } from "@/lib/docs-schema";
import { cn } from "@/lib/utils";

const TOOL_NAME = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;

// Text in which other tools' names link to their reference.
export function LinkedText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOOL_NAME)) {
    const href = TOOL_LINKS[m[1]];
    if (!href) continue;
    parts.push(text.slice(last, m.index));
    parts.push(
      <a key={`${m.index}`} href={href} className="font-mono text-[0.85em] text-link hover:underline" data-tool-link={m[1]}>
        {m[1]}
      </a>,
    );
    last = m.index! + m[1].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

export function AccessText({ access }: { access: DocsTool["access"] }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap" data-access={access}>
      <span className={cn("size-1.5 rounded-full", access === "read" ? "bg-emerald-500" : access === "write" ? "bg-amber-500" : "bg-red-500")} aria-hidden />
      {ACCESS_LABEL[access]}
    </span>
  );
}

// Builders hold innovator and developer together (one role, two names); admins hold every role.
export function rolesShown(roles: DocsRole[]): string[] {
  const set = new Set(roles);
  const out: string[] = [];
  if (set.has("developer") && set.has("innovator")) {
    out.push("Builder");
    set.delete("developer");
    set.delete("innovator");
  }
  for (const r of roles) if (set.has(r)) out.push(ROLE_LABEL[r]);
  return out;
}

export function RoleBadges({ roles }: { roles: DocsRole[] }) {
  return (
    <span className="flex flex-wrap gap-1" data-roles>
      {rolesShown(roles).map((r) => (
        <Badge key={r} variant="outline" className="font-normal">
          {r}
        </Badge>
      ))}
    </span>
  );
}

// Tool · What it does · Roles · Access, for one area's tools.
export function ToolTable({ tools }: { tools: DocsTool[] }) {
  return (
    <div className="mt-4 overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-sm" data-tool-table>
        <thead className="bg-muted/50">
          <tr className="border-b">
            <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Tool</th>
            <th className="px-3 py-2 text-xs font-medium text-muted-foreground">What it does</th>
            <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Roles</th>
            <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Access</th>
          </tr>
        </thead>
        <tbody>
          {tools.map((t) => (
            <tr key={t.name} className="border-b last:border-0" data-tool-row={t.name}>
              <td className="px-3 py-2 align-top">
                <a href={toolHref(t)} className="font-mono text-xs text-link hover:underline">
                  {t.name}
                </a>
              </td>
              <td className="px-3 py-2 align-top">{toolSummary(t)}</td>
              <td className="px-3 py-2 align-top">
                <RoleBadges roles={t.roles} />
              </td>
              <td className="px-3 py-2 align-top">
                <AccessText access={t.access} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AllTools() {
  return (
    <div data-all-tools>
      <p className="text-sm leading-relaxed">
        Mynt&apos;s MCP server has {CATALOGUE.tools.length} tools. Each person sees only the tools their roles allow; this reference lists them all, generated from the server&apos;s own tool registry.
      </p>
      {CATALOGUE.areas.map((a) => (
        <section key={a.id} data-area={a.id}>
          <h2 id={a.id} className="mt-10 scroll-mt-6 border-b pb-2 font-heading text-xl font-semibold" data-docs-heading>
            <a href={areaHref(a.id)} className="hover:underline">
              {a.title}
            </a>
          </h2>
          <p className="mt-3 text-sm text-muted-foreground">{a.summary}</p>
          <ToolTable tools={toolsInArea(a.id)} />
        </section>
      ))}
    </div>
  );
}

function InputsTable({ tool }: { tool: DocsTool }) {
  const rows = inputRows(tool.inputSchema);
  if (!rows.length) return <p className="mt-2 text-sm text-muted-foreground" data-no-inputs>This tool takes no inputs.</p>;
  return (
    <div className="mt-2 overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-sm" data-inputs-table>
        <thead className="bg-muted/50">
          <tr className="border-b">
            <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Name</th>
            <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Type</th>
            <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Required</th>
            <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Description</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-b last:border-0" data-input={r.name}>
              <td className="px-3 py-2 align-top font-mono text-xs whitespace-nowrap" style={{ paddingLeft: `${0.75 + r.depth}rem` }}>
                {r.name}
              </td>
              <td className="px-3 py-2 align-top font-mono text-xs">{r.type}</td>
              <td className="px-3 py-2 align-top text-xs">{r.required ? "Required" : "Optional"}</td>
              <td className="px-3 py-2 align-top">
                {r.description && (
                  <p className="text-sm">
                    <LinkedText text={r.description} />
                  </p>
                )}
                {r.values.length > 0 && (
                  <p className="mt-1 flex flex-wrap gap-1" data-enum>
                    {r.values.map((v) => (
                      <code key={v} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.75rem]">
                        {v}
                      </code>
                    ))}
                  </p>
                )}
                {r.constraints.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{r.constraints.join(" · ")}</p>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ToolSection({ tool }: { tool: DocsTool }) {
  const related = relatedTools(tool);
  return (
    <section className="mt-12 first:mt-0" data-tool={tool.name}>
      <h2 id={tool.name} className="scroll-mt-6 border-b pb-2 font-mono text-lg font-semibold" data-docs-heading>
        {tool.name}
      </h2>
      {tool.title && <p className="mt-3 font-heading text-base font-medium">{tool.title}</p>}
      <p className="mt-2 text-sm leading-relaxed">
        <LinkedText text={tool.description} />
      </p>
      <dl className="mt-4 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
        <dt className="text-xs text-muted-foreground">Roles</dt>
        <dd>
          <RoleBadges roles={tool.roles} />
        </dd>
        <dt className="text-xs text-muted-foreground">Access</dt>
        <dd>
          <AccessText access={tool.access} />
        </dd>
      </dl>
      <h3 className="mt-6 text-sm font-semibold">Inputs</h3>
      <InputsTable tool={tool} />
      <h3 className="mt-6 text-sm font-semibold">Example call</h3>
      <pre className="mt-2 overflow-x-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs leading-relaxed" data-example-call>
        {exampleCall(tool.name, tool.inputSchema)}
      </pre>
      {related.length > 0 && (
        <>
          <h3 className="mt-6 text-sm font-semibold">Related tools</h3>
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm" data-related>
            {related.map((r, i) => (
              <Fragment key={r.name}>
                <a href={toolHref(r)} className="font-mono text-xs text-link hover:underline">
                  {r.name}
                </a>
                {i < related.length - 1 && <span className="sr-only">, </span>}
              </Fragment>
            ))}
          </p>
        </>
      )}
    </section>
  );
}

export function AreaTools({ area }: { area: DocsArea }) {
  const tools = toolsInArea(area.id);
  return (
    <div data-area-page={area.id}>
      <p className="text-sm leading-relaxed">{area.summary}</p>
      <ToolTable tools={tools} />
      <div className="mt-12">
        {tools.map((t) => (
          <ToolSection key={t.name} tool={t} />
        ))}
      </div>
    </div>
  );
}
