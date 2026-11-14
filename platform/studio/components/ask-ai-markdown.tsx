"use client";

// Ask AI's answers: the studio's markdown (components/assistant-ui/markdown-text.tsx), except
// that a link to a studio page (a same-origin relative path, lib/studio-search.ts isStudioPath)
// is a real link, which AskAiPanel follows in place. Any other link is its text only, and images
// are their alt text: an answer can't send the browser, or a request, anywhere else.
import "@assistant-ui/react-markdown/styles/dot.css";

import { MarkdownTextPrimitive, unstable_memoizeMarkdownComponents as memoizeMarkdownComponents } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { memo, type ReactNode } from "react";

import { defaultComponents } from "@/components/assistant-ui/markdown-text";
import { isStudioPath } from "@/lib/studio-search";
import { cn } from "@/lib/utils";

/** A link in an answer: clickable only to a studio page. */
export function AnswerLink({ href, children, className }: { href?: string; children?: ReactNode; className?: string }) {
  if (isStudioPath(href))
    return (
      <a href={href} className={cn("aui-md-a font-medium text-primary underline underline-offset-4", className)} data-studio-link>
        {children}
      </a>
    );
  return <span className={cn("aui-md-a font-medium", className)}>{children}</span>;
}

const components = memoizeMarkdownComponents({
  ...defaultComponents,
  a: ({ className, children, href }) => (
    <AnswerLink href={href} className={className}>
      {children}
    </AnswerLink>
  ),
  img: ({ alt }) => <span className="text-muted-foreground">{alt ?? ""}</span>,
});

const AskAiMarkdownTextImpl = () => <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} className="aui-md" components={components} />;

export const AskAiMarkdownText = memo(AskAiMarkdownTextImpl);
