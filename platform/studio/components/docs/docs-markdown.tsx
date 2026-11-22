// A docs page's Markdown (the repository's own docs, cut by docs/site/manifest.json), rendered on the server with
// react-markdown and GitHub-flavoured tables. ## headings get the ids "On this page" links to (lib/docs.ts
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
      className={cn("font-medium text-link underline underline-offset-4", className)}
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
  const components: Components = {
    h2: ({ id, children }) => (
      <h2 id={id} className="mt-10 scroll-mt-6 border-b pb-2 font-heading text-xl font-semibold first:mt-0" data-docs-heading>
        {children}
      </h2>
    ),
    h3: ({ children }) => <h3 className="mt-8 font-heading text-base font-semibold">{children}</h3>,
    h4: ({ children }) => <h4 className="mt-6 text-sm font-semibold">{children}</h4>,
    h5: ({ children }) => <h5 className="mt-4 text-sm font-semibold">{children}</h5>,
    h6: ({ children }) => <h6 className="mt-4 text-sm font-semibold">{children}</h6>,
    p: ({ children }) => <p className="mt-4 text-sm leading-relaxed">{children}</p>,
    ul: ({ children }) => <ul className="mt-4 list-disc space-y-1.5 pl-5 text-sm leading-relaxed">{children}</ul>,
    ol: ({ children }) => <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed">{children}</ol>,
    blockquote: ({ children }) => <blockquote className="mt-4 border-l-2 pl-4 text-muted-foreground">{children}</blockquote>,
    hr: () => <hr className="my-8" />,
    a: ({ href, children }) => <DocsLink href={href}>{children}</DocsLink>,
    img: ({ alt }) => <span className="text-muted-foreground">{alt ?? ""}</span>,
    pre: ({ children }) => <pre className="mt-4 overflow-x-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs leading-relaxed">{children}</pre>,
    code: ({ className, children }) => {
      const text = textOf(children);
      // A block's code (inside pre) keeps its text; inline code that names a tool links to it.
      if (className || text.includes("\n")) return <code className={className}>{children}</code>;
      const href = toolLinks[text];
      const chip = <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.8em]">{children}</code>;
      return href ? (
        <a href={href} className="hover:underline" data-tool-link={text}>
          {chip}
        </a>
      ) : (
        chip
      );
    },
    table: ({ children }) => (
      <div className="mt-4 overflow-x-auto rounded-lg border">
        <table className="w-full text-left text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
    tr: ({ children }) => <tr className="border-b last:border-0">{children}</tr>,
    th: ({ children }) => <th className="px-3 py-2 text-xs font-medium whitespace-nowrap text-muted-foreground">{children}</th>,
    td: ({ children }) => <td className="px-3 py-2 align-top">{children}</td>,
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
