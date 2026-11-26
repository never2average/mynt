'use client';
// "Ask AI" in the Cmd+K bar: with a question of a few words typed, the first result asks for a short answer from
// Mynt's own data (POST /api/ask in Studio, /api/admin/ask in the platform admin; lib/ask-server.ts). The answer opens
// in a dialog and streams in as the model writes it (server-sent events): markdown with numbered citations that open
// the cited pages, the sources under it, and what to do when there is no AI summary (a limit, or no model answered):
// the sources it read still show.
import { useKBar, useRegisterActions } from 'kbar';
import Link from 'next/link';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { IconSparkles } from '@tabler/icons-react';
import { Markdown } from './markdown';
import { Dialog, DialogContent, DialogHeader, DialogTitle, Input, Spinner } from './ui';
import { useAskStatus } from './sources';
import { askErrorText } from '@/lib/ask-client';
import { ASK_URL, askable, linked, UNAVAILABLE, type AskAnswer, type AskArea, type AskSource, type AskStreamEvent } from '@/lib/ask-answer';

interface AnswerState { sources: AskSource[]; text: string; done: AskAnswer | null; error: string | null }

/** Answers already read this visit, by area and question: asking again shows them without a second model call. */
const answered = new Map<string, AskAnswer>();
/** Forgets them (the tests'). */
export const forgetAnswers = () => answered.clear();

/**
 * Ask, and follow the answer as it streams: sources first, then the text as it is written, then the cleaned answer.
 * A server that answers in one piece (JSON) is read the same way.
 */
function useStreamedAnswer(area: AskArea, question: string | null): AnswerState & { streaming: boolean } {
  const [state, setState] = useState<AnswerState>({ sources: [], text: '', done: null, error: null });
  useEffect(() => {
    if (!question) return;
    const key = `${area}\u0000${question}`;
    const cached = answered.get(key);
    if (cached) { setState({ sources: cached.sources, text: cached.answer ?? '', done: cached, error: null }); return; }
    setState({ sources: [], text: '', done: null, error: null });
    const ctl = new AbortController();
    const url = ASK_URL[area];
    (async () => {
      const res = await fetch(url, { method: 'POST', credentials: 'same-origin', signal: ctl.signal, body: JSON.stringify({ question }),
        headers: { 'Content-Type': 'application/json', accept: 'text/event-stream' } });
      // A refusal is shown as a sentence, never raw JSON (lib/ask-client.ts).
      if (!res.ok) throw new Error(askErrorText(await res.text().catch(() => '')));
      if (!(res.headers.get('content-type') ?? '').includes('event-stream')) {
        const d = (await res.json()) as AskAnswer;
        // A limit's reply isn't kept: asking again later gets an answer.
        if (!d.reason) answered.set(key, d);
        return setState({ sources: d.sources ?? [], text: d.answer ?? '', done: d, error: null });
      }
      const reader = res.body!.getReader(), decoder = new TextDecoder();
      let buf = '', sources: AskSource[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, cut).split('\n').find((l) => l.startsWith('data:'));
          buf = buf.slice(cut + 2);
          if (!line) continue;
          const e = JSON.parse(line.slice(5)) as AskStreamEvent;
          if (e.type === 'sources') { sources = e.sources; setState((s) => ({ ...s, sources })); }
          else if (e.type === 'delta') setState((s) => ({ ...s, text: s.text + e.text }));
          else if (e.type === 'reset') setState((s) => ({ ...s, text: '' }));
          else {
            const d: AskAnswer = { answer: e.answer, covered: e.covered, sources, model: e.model, reason: e.reason };
            if (!d.reason) answered.set(key, d);
            setState({ sources, text: e.answer ?? '', done: d, error: null });
          }
        }
      }
    })().catch((e: Error) => { if (e.name !== 'AbortError') setState((s) => ({ ...s, error: e.message })); });
    return () => ctl.abort();
  }, [area, question]);
  return { ...state, streaming: !!question && !state.done && !state.error };
}

const AskCtx = createContext<(question: string) => void>(() => {});
export const useAskAi = () => useContext(AskCtx);

/** Holds the dialog; children (the Cmd+K bar) open it with useAskAi(). */
export function AskAiProvider({ area, children }: { area: AskArea; children: ReactNode }) {
  const [question, setQuestion] = useState<string | null>(null);
  return (
    <AskCtx.Provider value={setQuestion}>
      {children}
      <AskAiDialog area={area} question={question} onQuestion={setQuestion} />
    </AskCtx.Provider>
  );
}

/** The "Ask AI: <query>" action for whatever is typed, above every other section. `q`: the query, trimmed. */
export const askAction = (q: string, ask: (q: string) => void) => ({
  id: 'ask-ai', name: `Ask AI: ${q}`, keywords: q, priority: 10,
  section: { name: 'Ask AI', priority: 10 }, subtitle: "A short answer from Mynt's data, with its sources",
  icon: <IconSparkles className='text-primary size-4' />, perform: () => ask(q)
});

/** Registers the "Ask AI: <query>" action for whatever is typed, above every other section. With no model configured there is no such action. */
export function AskAiAction({ area }: { area: AskArea }) {
  const { search, open } = useKBar((s) => ({ search: s.searchQuery, open: s.visualState !== 'hidden' }));
  const ask = useAskAi();
  const enabled = useAskStatus(open, area) === 'enabled';
  const q = search.trim();
  const actions = useMemo(() => (enabled && askable(q) ? [askAction(q, ask)] : []), [enabled, q, ask]);
  useRegisterActions(actions, [actions]);
  return null;
}

const WHAT: Record<AskArea, { about: string; reading: string; from: string }> = {
  studio: { about: 'Ask a question about your Mynt data', reading: 'Reading your Mynt data…', from: 'AI summary from your Mynt data' },
  admin: { about: 'Ask a question about Mynt', reading: "Reading Mynt's data…", from: "AI summary from Mynt's data" }
};

export function AskAiDialog({ area, question, onQuestion }: { area: AskArea; question: string | null; onQuestion: (q: string | null) => void }) {
  const q = question ?? '';
  const { sources, text, done, error, streaming } = useStreamedAnswer(area, question);
  const close = () => onQuestion(null);
  // A link in the answer or the sources opens the page: the dialog goes away.
  const onLinkClick = (e: React.MouseEvent) => { if ((e.target as HTMLElement).closest('a')) close(); };
  const what = WHAT[area];

  return (
    <Dialog open={!!question} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className='max-h-[85svh] gap-0 overflow-y-auto p-0 sm:max-w-xl' aria-describedby={undefined}>
        <DialogHeader className='border-b p-4 pr-12'>
          <DialogTitle className='flex items-center gap-2'><IconSparkles className='text-primary size-4' /> Ask AI</DialogTitle>
          <form className='mt-2' onSubmit={(e) => {
            e.preventDefault();
            const next = String(new FormData(e.currentTarget).get('question') ?? '').trim();
            if (next.length >= 3) onQuestion(next);
          }}>
            <Input key={q} name='question' defaultValue={q} aria-label='Your question' maxLength={400} placeholder={what.about} />
          </form>
        </DialogHeader>

        <div className='flex flex-col gap-4 p-4' onClick={onLinkClick}>
          {error ? (
            <p className='text-destructive text-sm'>{error}</p>
          ) : text ? (
            <div className='flex flex-col gap-2' aria-live='polite' aria-busy={streaming}>
              <Markdown className='max-w-none text-sm [&_a]:no-underline [&_p]:my-2 [&_p]:leading-6 [&_ul]:my-2'>{linked(text, sources)}</Markdown>
              {streaming ? <span className='bg-primary inline-block h-4 w-1.5 animate-pulse rounded-sm' aria-hidden />
                : <p className='text-muted-foreground text-xs'>{what.from} — may be imperfect{done?.model ? ` (${done.model})` : ''}.</p>}
            </div>
          ) : streaming ? (
            <div className='text-muted-foreground flex items-center gap-2 py-6 text-sm' role='status'><Spinner className='size-4' /> {what.reading}</div>
          ) : done ? (
            <p className='text-muted-foreground text-sm'>{UNAVAILABLE[(done.reason ?? 'unavailable') as keyof typeof UNAVAILABLE]}</p>
          ) : null}
          {sources.length > 0 && (
            <div className='flex flex-col gap-2 border-t pt-3'>
              <span className='text-muted-foreground text-xs font-medium tracking-wider uppercase'>Sources</span>
              <ol className='flex flex-col gap-1'>
                {sources.map((s) => (
                  <li key={s.n} className='flex gap-2 text-sm'>
                    <span className='text-muted-foreground w-5 shrink-0 text-right tabular-nums'>{s.n}.</span>
                    <Link href={s.href} className='hover:text-primary min-w-0 transition-colors'>
                      {s.title}{s.heading && <span className='text-muted-foreground'> › {s.heading}</span>}
                    </Link>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
