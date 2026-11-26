'use client';
// "Ask AI" from the Cmd+K bar: with a question of a few words typed, the first result asks Mynt's own data (POST
// /api/ask in Studio, /api/admin/ask in the platform admin; lib/ask-server.ts). It opens a conversation panel of a
// fixed size: a header (New chat, close), the messages, which scroll, and the question field pinned at its foot.
// Each answer streams in as the model writes it (server-sent events), under the steps that led to it (the model's
// thinking and each read, on one line that opens into the list), with numbered citation chips that open the cited
// record, its sources, and Copy answer / Ask again. Follow-ups are answered with the conversation so far. The
// conversation is kept in memory for the visit only.
import { useKBar, useRegisterActions } from 'kbar';
import Link from 'next/link';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconArrowDown, IconArrowUp, IconChevronRight, IconCopy, IconPlayerStop, IconPlus, IconRefresh, IconSparkles } from '@tabler/icons-react';
import { Markdown, readTime } from './markdown';
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Spinner } from './ui';
import { useAskStatus } from './sources';
import { askErrorText } from '@/lib/ask-client';
import {
  ASK_URL, askable, linked, MAX_ASK_QUESTION, questionFrom, seconds, UNAVAILABLE, UNCITED,
  type AskAnswer, type AskArea, type AskSource, type AskStreamEvent, type AskTurn
} from '@/lib/ask-answer';
import { cn } from '@/lib/utils';

// ---------- the conversation ----------

export type AskStep =
  | { kind: 'reasoning'; id: string; text: string }
  | { kind: 'tool'; id: string; tool: string; label: string; args: string; status: 'running' | 'done' | 'failed'; ms?: number; summary?: string; result?: string; message?: string };

export interface Turn {
  id: number;
  question: string;
  /** The answer's text so far, then the cleaned answer. */
  text: string;
  steps: AskStep[];
  sources: AskSource[];
  done: AskAnswer | null;
  error: string | null;
  stopped: boolean;
  streaming: boolean;
}

/** One event of the stream applied to a turn. */
export function applyEvent(t: Turn, e: AskStreamEvent): Turn {
  if (e.type === 'sources') return { ...t, sources: e.sources };
  if (e.type === 'delta') return { ...t, text: t.text + e.text };
  if (e.type === 'reset') return { ...t, text: '' };
  if (e.type === 'reasoning') {
    const last = t.steps[t.steps.length - 1];
    if (last?.kind === 'reasoning' && last.id === e.id) return { ...t, steps: [...t.steps.slice(0, -1), { ...last, text: last.text + e.text }] };
    return { ...t, steps: [...t.steps, { kind: 'reasoning', id: e.id, text: e.text }] };
  }
  if (e.type === 'tool_start') return { ...t, steps: [...t.steps, { kind: 'tool', id: e.id, tool: e.tool, label: e.label, args: e.args, status: 'running' }] };
  if (e.type === 'tool_end')
    return { ...t, steps: t.steps.map((s) => (s.kind === 'tool' && s.id === e.id ? { ...s, status: e.ok ? 'done' : 'failed', ms: e.ms, summary: e.summary, result: e.result, message: e.message } : s)) };
  const done: AskAnswer = { answer: e.answer, covered: e.covered, sources: t.sources, model: e.model, reason: e.reason, uncited: e.uncited, thoughtMs: e.thoughtMs };
  return { ...t, text: e.answer ?? '', done, streaming: false };
}

/** The conversation so far as the server takes it: each answered question and its answer, as text. */
export const historyOf = (turns: Turn[]): AskTurn[] =>
  turns.flatMap((t) => (t.done?.answer ? [{ role: 'user' as const, text: t.question }, { role: 'assistant' as const, text: t.done.answer }] : []));

let nextTurn = 1;

/** The conversation: its turns, asking (a follow-up carries the turns before it), stopping, asking a turn again and starting over. */
export function useConversation(area: AskArea) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const live = useRef<Turn[]>([]);
  const ctl = useRef<AbortController | null>(null);
  const set = useCallback((next: Turn[]) => { live.current = next; setTurns(next); }, []);
  const patch = useCallback((id: number, f: (t: Turn) => Turn) => set(live.current.map((t) => (t.id === id ? f(t) : t))), [set]);

  const run = useCallback((question: string, before: Turn[]) => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    const turn: Turn = { id: nextTurn++, question, text: '', steps: [], sources: [], done: null, error: null, stopped: false, streaming: true };
    set([...before.map((t) => (t.streaming ? { ...t, streaming: false, stopped: true } : t)), turn]);
    (async () => {
      const res = await fetch(ASK_URL[area], { method: 'POST', credentials: 'same-origin', signal: c.signal, body: JSON.stringify({ question, history: historyOf(before) }),
        headers: { 'Content-Type': 'application/json', accept: 'text/event-stream' } });
      // A refusal is shown as a sentence, never raw JSON (lib/ask-client.ts).
      if (!res.ok) throw new Error(askErrorText(await res.text().catch(() => '')));
      if (!(res.headers.get('content-type') ?? '').includes('event-stream')) {
        const d = (await res.json()) as AskAnswer;
        return patch(turn.id, (t) => ({ ...t, sources: d.sources ?? [], text: d.answer ?? '', done: { ...d, sources: d.sources ?? [] }, streaming: false }));
      }
      const reader = res.body!.getReader(), decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        // Stopped, or a newer question took its place: what still arrives is dropped.
        if (c.signal.aborted) { void reader.cancel().catch(() => undefined); return; }
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, cut).split('\n').find((l) => l.startsWith('data:'));
          buf = buf.slice(cut + 2);
          if (!line) continue;
          const e = JSON.parse(line.slice(5)) as AskStreamEvent;
          patch(turn.id, (t) => applyEvent(t, e));
        }
      }
      // A stream that ended with no answer: nothing more is coming.
      patch(turn.id, (t) => (t.streaming ? { ...t, streaming: false, error: t.text ? null : UNAVAILABLE.unavailable, stopped: Boolean(t.text) } : t));
    })().catch((e: Error) => {
      if (e.name === 'AbortError') patch(turn.id, (t) => (t.streaming ? { ...t, streaming: false, stopped: true } : t));
      else patch(turn.id, (t) => ({ ...t, streaming: false, error: e.message || UNAVAILABLE.unavailable }));
    });
  }, [area, patch, set]);

  const ask = useCallback((question: string) => { const q = questionFrom(question); if (q) run(q, live.current); }, [run]);
  const stop = useCallback(() => {
    ctl.current?.abort();
    set(live.current.map((t) => (t.streaming ? { ...t, streaming: false, stopped: true } : t)));
  }, [set]);
  const clear = useCallback(() => { ctl.current?.abort(); set([]); }, [set]);
  /** Asks a turn's question again, in place of that turn and what followed it. */
  const again = useCallback((id: number) => {
    const i = live.current.findIndex((t) => t.id === id);
    if (i >= 0) run(live.current[i].question, live.current.slice(0, i));
  }, [run]);
  return { turns, ask, stop, clear, again, streaming: turns.some((t) => t.streaming) };
}
export type Conversation = ReturnType<typeof useConversation>;

// ---------- the provider and the bar's actions ----------

type Panel = { ask: (question: string) => void; open: () => void; started: boolean };
const AskCtx = createContext<Panel>({ ask: () => {}, open: () => {}, started: false });
/** Asks a question: the panel opens with it already asked (a follow-up, when a conversation is under way). */
export const useAskAi = () => useContext(AskCtx).ask;

/** Holds the panel and its conversation; children (the Cmd+K bar) open it with useAskAi(). */
export function AskAiProvider({ area, children }: { area: AskArea; children: ReactNode }) {
  const conversation = useConversation(area);
  const [open, setOpen] = useState(false);
  const { ask } = conversation;
  const panel = useMemo<Panel>(() => ({
    ask: (question) => { setOpen(true); ask(question); },
    open: () => setOpen(true),
    started: conversation.turns.length > 0
  }), [ask, conversation.turns.length]);
  return (
    <AskCtx.Provider value={panel}>
      {children}
      <AskAiDialog area={area} open={open} onOpenChange={setOpen} conversation={conversation} />
    </AskCtx.Provider>
  );
}

/** The "Ask AI: <query>" action for whatever is typed, above every other section. `q`: the query, trimmed. */
export const askAction = (q: string, ask: (q: string) => void) => ({
  id: 'ask-ai', name: `Ask AI: ${q}`, keywords: q, priority: 10,
  section: { name: 'Ask AI', priority: 10 }, subtitle: "An answer from Mynt's data, with its sources",
  icon: <IconSparkles className='text-primary size-4' />, perform: () => ask(q)
});
/** The way back to a conversation under way. */
export const resumeAction = (open: () => void) => ({
  id: 'ask-ai-resume', name: 'Ask AI: back to the conversation', keywords: 'ask ai conversation chat follow-up', priority: 9,
  section: { name: 'Ask AI', priority: 10 }, subtitle: 'Ask a follow-up, or read the answers again',
  icon: <IconSparkles className='text-primary size-4' />, perform: open
});

/** Registers the "Ask AI" actions: the question typed, and the way back to a conversation. With no model configured there is none. */
export function AskAiAction({ area }: { area: AskArea }) {
  const { search, open } = useKBar((s) => ({ search: s.searchQuery, open: s.visualState !== 'hidden' }));
  const panel = useContext(AskCtx);
  const enabled = useAskStatus(open, area) === 'enabled';
  const q = search.trim();
  const { ask, open: resume, started } = panel;
  const actions = useMemo(() => (!enabled ? [] : [...(askable(q) ? [askAction(q, ask)] : []), ...(started ? [resumeAction(resume)] : [])]), [enabled, q, ask, resume, started]);
  useRegisterActions(actions, [actions]);
  return null;
}

// ---------- the panel ----------

const WHAT: Record<AskArea, { about: string; empty: string; from: string }> = {
  studio: { about: 'Ask about your Mynt data', empty: 'Ask about your apps, builds, members, licences or the audit trail.', from: 'AI summary from your Mynt data' },
  admin: { about: 'Ask about Mynt', empty: 'Ask about workspaces, regulated firms, vendors, risks or the audit trail.', from: "AI summary from Mynt's data" }
};

/** The panel's size: fixed at 60% of the screen's height and a third of its width (never under 22rem); the whole screen below the sm breakpoint. */
export const PANEL_SIZE = 'h-[60vh] w-[33vw] max-w-none min-w-[22rem] sm:max-w-none max-sm:h-dvh max-sm:w-screen max-sm:min-w-0 max-sm:rounded-none';

/** A turn's steps on one line: what it's doing now, then what it took. Null when there's nothing to say. */
export function stepsLine(t: Turn): string | null {
  const reads = t.steps.filter((s) => s.kind === 'tool');
  if (t.streaming) {
    const running = [...reads].reverse().find((s) => s.status === 'running');
    if (running && running.kind === 'tool') return `${running.label.replace(/^Read /, 'Reading ')}…`;
    if (t.text) return 'Writing the answer…';
    return t.steps[t.steps.length - 1]?.kind === 'reasoning' ? 'Thinking…' : 'Working…';
  }
  const parts = [
    ...(reads.length ? [`Used ${reads.length} ${reads.length === 1 ? 'read' : 'reads'}`] : []),
    ...(t.done?.thoughtMs !== undefined && t.steps.some((s) => s.kind === 'reasoning') ? [`Thought for ${seconds(t.done.thoughtMs)}`] : [])
  ];
  return parts.length ? parts.join(' · ') : null;
}

const STATUS = { running: 'Running', done: 'Done', failed: 'Failed' } as const;

function ToolStep({ step }: { step: Extract<AskStep, { kind: 'tool' }> }) {
  const [shown, setShown] = useState(false);
  return (
    <li className='flex flex-col gap-1' data-step='tool' data-status={step.status}>
      <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
        <span className='text-foreground font-medium'>{step.label}</span>
        <code className='bg-muted rounded-sm border px-1 font-mono text-[10px]'>{step.tool}</code>
      </div>
      {step.args && <span className='break-words'>{step.args}</span>}
      <span>
        {STATUS[step.status]}
        {step.status === 'failed' && step.message ? `: ${step.message}` : ''}
        {step.status === 'done' && step.summary ? ` · ${step.summary}` : ''}
        {step.ms !== undefined && step.status !== 'running' ? ` · ${seconds(step.ms)}` : ''}
      </span>
      {step.result && (
        <>
          <Button variant='ghost' size='sm' className='self-start' aria-expanded={shown} onClick={() => setShown((v) => !v)}>
            <IconChevronRight className={cn('transition-transform', shown && 'rotate-90')} /> {shown ? 'Hide result' : 'Show result'}
          </Button>
          {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrolls: reachable by keyboard */}
          {shown && <pre tabIndex={0} className='bg-muted max-h-48 overflow-auto rounded-md border p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap'>{step.result}</pre>}
        </>
      )}
    </li>
  );
}

/** A turn's steps: one line that updates as they happen, opening into the list (the model's thinking and each read, in order). */
function Steps({ turn }: { turn: Turn }) {
  const [open, setOpen] = useState(false);
  const line = stepsLine(turn);
  if (!line) return null;
  return (
    <div className='text-muted-foreground flex flex-col gap-2 text-xs' data-steps>
      <Button variant='ghost' size='sm' className='self-start' aria-expanded={open} disabled={!turn.steps.length} onClick={() => setOpen((v) => !v)}>
        {turn.streaming ? <Spinner className='size-3.5' /> : <IconChevronRight className={cn('transition-transform', open && 'rotate-90')} />}
        <span aria-live='polite'>{line}</span>
      </Button>
      {open && turn.steps.length > 0 && (
        <ol className='flex flex-col gap-3 border-l pl-3'>
          {turn.steps.map((s) => s.kind === 'reasoning' ? (
            <li key={s.id} className='flex flex-col gap-1' data-step='reasoning'>
              <span className='text-foreground font-medium'>Thinking</span>
              <p className='bg-muted/60 rounded-md p-2 leading-relaxed whitespace-pre-wrap'>{s.text}</p>
            </li>
          ) : <ToolStep key={s.id} step={s} />)}
        </ol>
      )}
    </div>
  );
}

function Answer({ turn, what, last, onAgain }: { turn: Turn; what: typeof WHAT[AskArea]; last: boolean; onAgain: () => void }) {
  const [copied, setCopied] = useState(false);
  const { done, sources, text, streaming, error } = turn;
  const copy = () => {
    void navigator.clipboard?.writeText(done?.answer ?? text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => undefined);
  };
  return (
    <div className='flex flex-col gap-3' data-turn={turn.id}>
      <p className='bg-muted text-foreground max-w-[85%] self-end rounded-lg px-3 py-2 text-sm break-words whitespace-pre-wrap' data-question>{turn.question}</p>
      <Steps turn={turn} />
      {error ? (
        <p className='text-destructive text-sm' role='alert'>{error}</p>
      ) : text ? (
        <div className='flex flex-col gap-2' aria-live='polite' aria-busy={streaming} data-answer>
          <Markdown sources={sources} className='max-w-none text-sm [&_a]:no-underline [&_p]:my-2 [&_p]:leading-6 [&_ul]:my-2'>{linked(text, sources)}</Markdown>
          {streaming ? <span className='bg-primary inline-block h-4 w-1.5 animate-pulse rounded-sm' aria-hidden />
            : turn.stopped ? <p className='text-muted-foreground text-xs'>Stopped.</p>
            : (
              <>
                {done?.uncited && <p className='text-muted-foreground text-xs' data-uncited>{UNCITED}</p>}
                <p className='text-muted-foreground text-xs'>{what.from} — may be imperfect{done?.model ? ` (${done.model})` : ''}.</p>
              </>
            )}
        </div>
      ) : streaming ? null : turn.stopped ? (
        <p className='text-muted-foreground text-sm'>Stopped.</p>
      ) : done ? (
        <p className='text-muted-foreground text-sm'>{UNAVAILABLE[(done.reason ?? 'unavailable') as keyof typeof UNAVAILABLE]}</p>
      ) : null}
      {!streaming && sources.length > 0 && text && (
        <div className='flex flex-col gap-2 border-t pt-3' data-sources>
          <span className='text-muted-foreground text-xs font-medium tracking-wider uppercase'>Sources</span>
          <ol className='flex flex-col gap-1'>
            {sources.map((s) => (
              <li key={s.n} className='flex gap-2 text-sm'>
                <span className='text-muted-foreground w-5 shrink-0 text-right tabular-nums'>{s.n}.</span>
                <Link href={s.href} className='hover:text-primary min-w-0 transition-colors' title={`Read ${readTime(s.readAt)} · ${s.tool}`}>
                  {s.title}
                </Link>
              </li>
            ))}
          </ol>
        </div>
      )}
      {!streaming && (
        <div className='flex flex-wrap gap-1.5'>
          {done?.answer && (
            <Button variant='ghost' size='sm' onClick={copy}><IconCopy /> <span aria-live='polite'>{copied ? 'Copied' : 'Copy answer'}</span></Button>
          )}
          {last && <Button variant='ghost' size='sm' onClick={onAgain}><IconRefresh /> Ask again</Button>}
        </div>
      )}
    </div>
  );
}

/** The question field, pinned at the panel's foot: Enter sends, Shift+Enter starts a new line; Stop while an answer is coming. */
function Composer({ about, streaming, onSend, onStop, focusKey }: { about: string; streaming: boolean; onSend: (q: string) => void; onStop: () => void; focusKey: unknown }) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  // It grows with what's typed, to five lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [value]);
  // The field takes focus when the panel opens, and again when an answer ends.
  useEffect(() => { if (!streaming) ref.current?.focus(); }, [streaming, focusKey]);
  const ready = !streaming && questionFrom(value) !== null;
  const send = () => {
    if (!ready) return;
    onSend(value);
    setValue('');
  };
  return (
    <form className='flex flex-col gap-1.5 border-t p-3' data-composer onSubmit={(e) => { e.preventDefault(); send(); }}>
      <div className='flex items-end gap-2'>
        <textarea
          ref={ref} name='question' rows={1} value={value} maxLength={MAX_ASK_QUESTION} aria-label='Your question' placeholder={about}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
          className='border-border placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 max-h-[7.5rem] min-h-8 w-full min-w-0 flex-1 resize-none rounded-lg border bg-transparent px-2.5 py-1.5 text-base leading-5 transition-colors outline-none focus-visible:ring-3 md:text-sm'
        />
        {streaming
          ? <Button type='button' variant='outline' onClick={onStop}><IconPlayerStop /> Stop</Button>
          : <Button type='submit' disabled={!ready}><IconArrowUp /> Send</Button>}
      </div>
      {value.length >= MAX_ASK_QUESTION - 50 && <span className='text-muted-foreground self-end text-xs tabular-nums' aria-live='polite'>{value.length}/{MAX_ASK_QUESTION}</span>}
    </form>
  );
}

export function AskAiDialog({ area, open, onOpenChange, conversation }: { area: AskArea; open: boolean; onOpenChange: (open: boolean) => void; conversation: Conversation }) {
  const { turns, ask, stop, clear, again, streaming } = conversation;
  const what = WHAT[area];
  const close = () => onOpenChange(false);
  // A link in an answer or its sources opens the page: the panel goes away (the conversation stays).
  const onLinkClick = (e: React.MouseEvent) => { if ((e.target as HTMLElement).closest('a')) close(); };

  // The messages follow the stream, unless the reader has scrolled up: then "Jump to latest" brings them back.
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [away, setAway] = useState(false);
  const toLatest = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    stuck.current = true;
    setAway(false);
  }, []);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setAway(!stuck.current);
  };
  useEffect(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [turns, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('flex flex-col gap-0 overflow-hidden p-0', PANEL_SIZE)} aria-describedby={undefined} data-ask-panel={area}>
        <DialogHeader className='border-b p-4 pr-12'>
          <div className='flex items-center gap-2'>
            <DialogTitle className='flex items-center gap-2'><IconSparkles className='text-primary size-4' /> Ask AI</DialogTitle>
            <Button variant='ghost' size='sm' className='ml-auto' disabled={!turns.length} onClick={() => { clear(); toLatest(); }}><IconPlus /> New chat</Button>
          </div>
        </DialogHeader>

        <div className='relative min-h-0 flex-1'>
          <div ref={scroller} onScroll={onScroll} onClick={onLinkClick} className='flex h-full flex-col gap-6 overflow-y-auto p-4' data-ask-messages>
            {turns.length === 0
              ? <p className='text-muted-foreground m-auto max-w-xs text-center text-sm'>{what.empty}</p>
              : turns.map((t, i) => <Answer key={t.id} turn={t} what={what} last={i === turns.length - 1} onAgain={() => { again(t.id); toLatest(); }} />)}
          </div>
          {away && (
            <Button variant='outline' size='sm' className='absolute bottom-2 left-1/2 -translate-x-1/2 shadow-sm' onClick={toLatest}><IconArrowDown /> Jump to latest</Button>
          )}
        </div>

        <Composer about={what.about} streaming={streaming} onSend={(q) => { ask(q); toLatest(); }} onStop={stop} focusKey={open} />
      </DialogContent>
    </Dialog>
  );
}
