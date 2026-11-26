"use client";

// Ask AI in the Cmd+K search (components/studio-search.tsx): with a question of a few words typed, the first result
// asks for a short answer from Mynt's own data (POST /api/ask in the studio, /api/admin/ask in the platform admin).
// The answer opens in a dialog and streams in as the model writes it (server-sent events): markdown with numbered
// citations that open the cited pages, the sources under it (the reads it was made from, each as the page that shows
// that data), and what to do when there is no AI summary (a limit, or no model answered). The question can be edited
// and asked again in the dialog. Nothing is kept beyond this visit: answers already read are shown again from memory.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2, Sparkles } from "lucide-react";

import { AnswerLink } from "@/components/ask-ai-markdown";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { askErrorText } from "@/lib/ask-client";
import { ASK_URL, linked, MAX_ASK_QUESTION, MIN_QUESTION, UNAVAILABLE, type AskAnswer, type AskArea, type AskSource, type AskStreamEvent } from "@/lib/ask-answer";
import { isStudioPath } from "@/lib/studio-search";

export type AskStatus = "loading" | "enabled" | "disabled";

export const NOT_CONFIGURED = "AI is not configured";

interface AnswerState { sources: AskSource[]; text: string; done: AskAnswer | null; error: string | null }

/** Answers already read this visit, by area and question: asking again shows them without a second model call. */
const answered = new Map<string, AskAnswer>();
/** Forgets them (the tests'). */
export const forgetAnswers = () => answered.clear();

/**
 * Ask, and follow the answer as it streams: sources first, then the text as it is written, then the cleaned answer.
 * A server that answers in one piece (JSON) is read the same way.
 */
export function useStreamedAnswer(area: AskArea, question: string | null): AnswerState & { streaming: boolean } {
  const [state, setState] = useState<AnswerState>({ sources: [], text: "", done: null, error: null });
  useEffect(() => {
    if (!question) return;
    const key = `${area}\u0000${question}`;
    const cached = answered.get(key);
    if (cached) {
      setState({ sources: cached.sources, text: cached.answer ?? "", done: cached, error: null });
      return;
    }
    setState({ sources: [], text: "", done: null, error: null });
    const ctl = new AbortController();
    (async () => {
      const res = await fetch(ASK_URL[area], {
        method: "POST",
        credentials: "same-origin",
        signal: ctl.signal,
        body: JSON.stringify({ question }),
        headers: { "Content-Type": "application/json", accept: "text/event-stream" },
      });
      // A refusal is shown as a sentence, never raw JSON (lib/ask-client.ts).
      if (!res.ok) throw new Error(askErrorText(await res.text().catch(() => "")));
      if (!(res.headers.get("content-type") ?? "").includes("event-stream")) {
        const d = (await res.json()) as AskAnswer;
        // A limit's reply isn't kept: asking again later gets an answer.
        if (!d.reason) answered.set(key, d);
        return setState({ sources: d.sources ?? [], text: d.answer ?? "", done: d, error: null });
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let sources: AskSource[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const line = buf
            .slice(0, cut)
            .split("\n")
            .find((l) => l.startsWith("data:"));
          buf = buf.slice(cut + 2);
          if (!line) continue;
          const e = JSON.parse(line.slice(5)) as AskStreamEvent;
          if (e.type === "sources") {
            sources = e.sources;
            setState((s) => ({ ...s, sources }));
          } else if (e.type === "delta") setState((s) => ({ ...s, text: s.text + e.text }));
          else if (e.type === "reset") setState((s) => ({ ...s, text: "" }));
          else {
            const d: AskAnswer = { answer: e.answer, covered: e.covered, sources, model: e.model, reason: e.reason };
            if (!d.reason) answered.set(key, d);
            setState({ sources, text: e.answer ?? "", done: d, error: null });
          }
        }
      }
    })().catch((e: Error) => {
      if (e.name !== "AbortError") setState((s) => ({ ...s, error: e.message || "Ask AI couldn't answer just now. Please try again." }));
    });
    return () => ctl.abort();
  }, [area, question]);
  return { ...state, streaming: !!question && !state.done && !state.error };
}

const AskCtx = createContext<(question: string) => void>(() => {});
export const useAskAi = () => useContext(AskCtx);

/** Holds the dialog; children (the Cmd+K search) open it with useAskAi(). */
export function AskAiProvider({ area, children }: { area: AskArea; children: ReactNode }) {
  const [question, setQuestion] = useState<string | null>(null);
  return (
    <AskCtx.Provider value={setQuestion}>
      {children}
      <AskAiDialog area={area} question={question} onQuestion={setQuestion} />
    </AskCtx.Provider>
  );
}

// The answer's markdown: a link is followed only to a page of the studio (the citations); images are their alt text.
const components: Components = {
  a: ({ href, children }) => <AnswerLink href={href}>{children}</AnswerLink>,
  img: ({ alt }) => <span className="text-muted-foreground">{alt ?? ""}</span>,
};

const WHAT: Record<AskArea, { about: string; reading: string; from: string }> = {
  studio: { about: "Ask a question about your apps, builds, members or licences", reading: "Reading your Mynt data…", from: "AI summary from your Mynt data" },
  admin: { about: "Ask a question about Mynt: workspaces, firms, vendors, risks, the audit trail", reading: "Reading Mynt's data…", from: "AI summary from Mynt's data" },
};

export function AskAiDialog({ area, question, onQuestion }: { area: AskArea; question: string | null; onQuestion: (q: string | null) => void }) {
  const router = useRouter();
  const q = question ?? "";
  const { sources, text, done, error, streaming } = useStreamedAnswer(area, question);
  const close = () => onQuestion(null);
  // A link in the answer or the sources opens the page, in place: the dialog goes away.
  const onLinkClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const href = a.getAttribute("href") ?? "";
    e.preventDefault();
    if (!isStudioPath(href)) return;
    close();
    router.push(href);
  };
  const what = WHAT[area];

  return (
    <Dialog
      open={!!question}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <DialogContent className="max-h-[85svh] gap-0 overflow-y-auto p-0 sm:max-w-xl" data-ask-ai-dialog={area}>
        <DialogHeader className="border-b p-4 pr-12">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-link" aria-hidden /> Ask AI
          </DialogTitle>
          <DialogDescription className="sr-only">A short answer from Mynt&apos;s data, with its sources.</DialogDescription>
          <form
            className="mt-2"
            onSubmit={(e) => {
              e.preventDefault();
              const next = String(new FormData(e.currentTarget).get("question") ?? "").trim();
              if (next.length >= MIN_QUESTION) onQuestion(next);
            }}
          >
            <Input key={q} name="question" defaultValue={q} aria-label="Your question" maxLength={MAX_ASK_QUESTION} placeholder={what.about} data-ask-question />
          </form>
        </DialogHeader>

        <div className="flex flex-col gap-4 p-4" onClick={onLinkClick} data-ask-answer>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : text ? (
            <div className="flex flex-col gap-2" aria-live="polite" aria-busy={streaming}>
              <div className="aui-md max-w-none text-sm [&_a]:no-underline [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_p]:leading-6 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5" data-ask-text>
                <Markdown remarkPlugins={[remarkGfm]} components={components}>
                  {linked(text, sources)}
                </Markdown>
              </div>
              {streaming ? (
                <span className="inline-block h-4 w-1.5 animate-pulse rounded-sm bg-primary" aria-hidden />
              ) : (
                <p className="text-xs text-muted-foreground" data-ask-note>
                  {what.from} — may be imperfect{done?.model ? ` (${done.model})` : ""}.
                </p>
              )}
            </div>
          ) : streaming ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden /> {what.reading}
            </div>
          ) : done ? (
            <p className="text-sm text-muted-foreground" data-ask-unavailable={done.reason ?? "unavailable"}>
              {UNAVAILABLE[done.reason ?? "unavailable"]}
            </p>
          ) : null}
          {sources.length > 0 && (
            <div className="flex flex-col gap-2 border-t pt-3" data-ask-sources>
              <span className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Sources</span>
              <ol className="flex flex-col gap-1">
                {sources.map((s) => (
                  <li key={s.n} className="flex gap-2 text-sm">
                    <span className="w-5 shrink-0 text-right text-muted-foreground tabular-nums">{s.n}.</span>
                    <Link href={s.href} className="min-w-0 transition-colors hover:text-link" data-ask-source={s.n}>
                      {s.title}
                      {s.heading && <span className="text-muted-foreground"> › {s.heading}</span>}
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
