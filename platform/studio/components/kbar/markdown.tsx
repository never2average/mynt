import Link from 'next/link';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Children, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { isStudioPath } from '@/lib/studio-search';
import type { AskSource } from '@/lib/ask-answer';

const LINK = 'text-primary decoration-primary/40 hover:decoration-primary font-medium underline underline-offset-4 transition-colors';
/** A citation: a small chip with the source's number. */
export const CITE = 'bg-accent text-accent-foreground hover:bg-primary hover:text-primary-foreground focus-visible:ring-ring/50 mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-sm border px-1 align-text-top text-[10px] font-medium tabular-nums no-underline transition-colors outline-none focus-visible:ring-3';
/** What it shows on hover or focus: the source's title and when it was read. */
export const CITE_TIP = 'bg-popover text-popover-foreground pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden w-max max-w-64 -translate-x-1/2 rounded-md border px-2 py-1 text-xs font-normal shadow-md group-hover/cite:block group-focus-within/cite:block';

/** When a source was read, as a time of day. */
export const readTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

/** A citation chip: its number, linked to the source, with the source's title and when it was read on hover or focus. */
export function Citation({ source }: { source: AskSource }) {
  const time = readTime(source.readAt);
  return (
    <span className='group/cite relative inline-block' data-cite={source.n}>
      <Link href={source.href} className={CITE} aria-label={`Source ${source.n}: ${source.title}`}>{source.n}</Link>
      <span role='tooltip' className={CITE_TIP}>{source.title}{time && <span className='text-muted-foreground'> · read {time}</span>}</span>
    </span>
  );
}

const flat = (n: ReactNode): string => Children.toArray(n).map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : '')).join('');

/** What an answer can hold: paragraphs, lists, emphasis and inline code (headings, tables and images are cleaned out). */
const ELEMENTS: Components = {
  p: ({ node: _n, ...p }) => <p className='my-4 leading-7' {...p} />,
  ul: ({ node: _n, ...p }) => <ul className='marker:text-muted-foreground my-4 ml-6 list-disc space-y-2 [&_ol]:my-2 [&_ul]:my-2' {...p} />,
  ol: ({ node: _n, ...p }) => <ol className='marker:text-muted-foreground my-4 ml-6 list-decimal space-y-2 [&_ol]:my-2 [&_ul]:my-2' {...p} />,
  li: ({ node: _n, ...p }) => <li className='pl-1 leading-7 [&>p]:my-1' {...p} />,
  hr: () => <hr className='my-10' />,
  strong: ({ node: _n, ...p }) => <strong className='text-foreground font-semibold' {...p} />,
  code: ({ node: _n, className: c, ...p }) => <code className={cn('bg-muted rounded-md border px-1.5 py-0.5 font-mono text-[0.85em] break-words', c)} {...p} />,
  img: ({ alt }) => <span className='text-muted-foreground'>{alt ?? ''}</span>
};

/**
 * An answer's markdown, styled with the search's own tokens. Raw HTML in the source shows as text. A link is followed
 * only to a page of Studio (a same-origin relative path); any other link is its text only. A link whose text is a
 * citation ("[2]") of one of `sources` is that source's chip.
 */
export function Markdown({ children, className, sources = [] }: { children: string; className?: string; sources?: AskSource[] }) {
  const components: Components = {
    ...ELEMENTS,
    a: ({ node: _n, href = '', children: c }) => {
      const cited = /^\[(\d{1,2})\]$/.exec(flat(c));
      const source = cited ? sources.find((s) => s.n === Number(cited[1]) && s.href === href) : undefined;
      if (source && isStudioPath(source.href)) return <Citation source={source} />;
      return isStudioPath(href) ? <Link href={href} className={LINK}>{c}</Link> : <span className='font-medium'>{c}</span>;
    }
  };
  return (
    <div className={cn('text-foreground max-w-3xl text-[15px] break-words', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{children}</ReactMarkdown>
    </div>
  );
}
