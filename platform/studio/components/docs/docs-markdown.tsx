// A docs page's Markdown (the repository's own docs, cut by docs/site/manifest.json), rendered on the server with
// react-markdown and GitHub-flavoured tables, set by Fumadocs' typography (DocsBody). ## headings get the ids "On this page" links to (lib/docs.ts
// markdownHeadings gives the same ones); a tool's name in code links to its reference; links leave in a new tab.
// The docs change only on deploy, so each page's Markdown is parsed once and its rendered tree kept.
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { slugify, uniqueId } from "@/lib/docs";
import { cn } from "@/lib/utils";

export function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return Children.toArray(node).map(textOf).join("");
}

export function DocsLink({ href, children, className }: { href?: string; children?: ReactNode; className?: string }) {
  const external = !!href && /^https?:/.test(href);
  return (
    <a
      href={href}
      className={cn("text-link", className)}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {children}
    </a>
  );
}

type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] };
const hastText = (n: HastNode): string => (n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(hastText).join(""));

// Gives each ## heading its id while the page is parsed: in document order, numbered when a heading repeats (as
// markdownHeadings numbers them).
function rehypeHeadingIds() {
  return (tree: HastNode) => {
    const seen = new Map<string, number>();
    const walk = (n: HastNode) => {
      if (n.type === "element" && n.tagName === "h2") n.properties = { ...n.properties, id: uniqueId(slugify(hastText(n)), seen) };
      for (const c of n.children ?? []) walk(c);
    };
    walk(tree);
  };
}

const rendered = new Map<string, ReactElement>();

export function DocsMarkdown({ source, toolLinks = {} }: { source: string; toolLinks?: Record<string, string> }) {
  const key = `${Object.keys(toolLinks).length}\u0000${source}`;
  const hit = rendered.get(key);
  if (hit) return hit;
  // Fumadocs' typography (DocsBody's prose) sets the text; these keep the ids, the tool links and the outbound links.
  const components: Components = {
    h2: ({ id, children }) => (
      <h2 id={id} data-docs-heading>
        {children}
      </h2>
    ),
    a: ({ href, children }) => <DocsLink href={href}>{children}</DocsLink>,
    img: ({ alt }) => <span className="text-muted-foreground">{alt ?? ""}</span>,
    table: ({ children }) => (
      <div className="overflow-x-auto">
        <table>{children}</table>
      </div>
    ),
    code: ({ className, children }) => {
      const text = textOf(children);
      // A block's code (inside pre) keeps its text; inline code that names a tool links to it.
      if (className || text.includes("\n")) return <code className={className}>{children}</code>;
      const href = toolLinks[text];
      return href ? (
        <a href={href} data-tool-link={text}>
          <code>{children}</code>
        </a>
      ) : (
        <code>{children}</code>
      );
    },
  };
  // Called as a function, so the parsed tree (not a component to render again) is what's kept.
  const tree = (
    <div className="docs-markdown" data-docs-markdown>
      {Markdown({ children: source, remarkPlugins: [remarkGfm], rehypePlugins: [rehypeHeadingIds], components })}
    </div>
  );
  rendered.set(key, tree);
  return tree;
}
