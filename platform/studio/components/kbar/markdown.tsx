import Link from 'next/link';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { isStudioPath } from '@/lib/studio-search';

const LINK = 'text-primary decoration-primary/40 hover:decoration-primary font-medium underline underline-offset-4 transition-colors';

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
 * only to a page of Studio (a same-origin relative path: the answer's citations); any other link is its text only.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  const components: Components = {
    ...ELEMENTS,
    a: ({ node: _n, href = '', children: c }) =>
      isStudioPath(href) ? <Link href={href} className={LINK}>{c}</Link> : <span className='font-medium'>{c}</span>
  };
  return (
    <div className={cn('text-foreground max-w-3xl text-[15px] break-words', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{children}</ReactMarkdown>
    </div>
  );
}
