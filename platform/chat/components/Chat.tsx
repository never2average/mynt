"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { SseParser, type TranscriptItem } from "@/lib/events";
import { appendEvent, visibleItems } from "@/lib/transcript";
import { ProductCard } from "./ProductCard";
import { RequestCard } from "./RequestCard";
import { useVisualViewport } from "./useVisualViewport";

export const SUGGESTIONS = [
  "I need ₹80,000 for six weeks of stock before Diwali, repaid a little each day",
  "Cover me for a slow season",
  "Let my regular customers pay later",
];

const DRAFT_KEY = "mynt-chat-draft"; // a suggestion picked before signing in
const AUTH_ERRORS: Record<string, string> = {
  start: "Couldn't start sign-in with Mynt. Please try again.",
  denied: "Sign-in was cancelled.",
  state: "Sign-in expired. Please try again.",
  session: "Sign-in expired. Please try again.",
  code: "Sign-in didn't complete. Please try again.",
  exchange: "Mynt didn't accept the sign-in. Please try again.",
};

function readDraft(): string {
  try {
    const draft = sessionStorage.getItem(DRAFT_KEY) ?? "";
    sessionStorage.removeItem(DRAFT_KEY);
    return draft;
  } catch {
    return "";
  }
}

function saveDraft(text: string): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, text);
  } catch {
    // private mode: the user just picks the suggestion again
  }
}

type AcceptState = "accepting" | "accepted";
type RequestState = "sending" | "sent";

interface SessionInfo {
  signedIn: boolean;
  transcript: TranscriptItem[];
  accepted?: string[];
  sentRequests?: string[];
}

const doneMap = <T extends string>(ids: string[] | undefined, state: T): Record<string, T> =>
  Object.fromEntries((ids ?? []).map((id) => [id, state]));

export function Chat() {
  useVisualViewport();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [accepts, setAccepts] = useState<Record<string, AcceptState>>({});
  const [requests, setRequests] = useState<Record<string, RequestState>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);

  // An Accept or Send request in flight: the server handles one thing at a time per session, so
  // sending a message waits for it too.
  const acting = Object.values(accepts).includes("accepting") || Object.values(requests).includes("sending");
  const locked = busy || acting;

  const note = useCallback((text: string, tone: "ok" | "error") => {
    setItems((prev) => [...prev, { kind: "note", text, tone }]);
  }, []);

  // Load the session (signed in? chat so far? what was already accepted or sent?) and any
  // sign-in error from the redirect.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("auth_error");
    if (authError) window.history.replaceState(null, "", window.location.pathname);
    fetch("/api/session", { cache: "no-store" })
      .then((r) => r.json() as Promise<SessionInfo>)
      .then((s) => {
        setSignedIn(s.signedIn);
        setItems(s.transcript);
        setAccepts(doneMap(s.accepted, "accepted"));
        setRequests(doneMap(s.sentRequests, "sent"));
        if (s.signedIn) setDraft(readDraft());
        if (authError) note(AUTH_ERRORS[authError] ?? AUTH_ERRORS.start, "error");
      })
      .catch(() => {
        setSignedIn(false);
        note("Couldn't reach the app. Check your connection and reload.", "error");
      });
  }, [note]);

  // Follow new messages, unless the user has scrolled up to read.
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [items, status, busy]);
  // The keyboard opening (or the composer growing) shrinks the scroll area without changing
  // scrollTop, which would hide the latest message behind the keyboard: stay pinned.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Grow the composer with its text, up to the CSS max-height. scrollHeight leaves out the
  // border, which the border-box height includes.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [draft]);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || locked) return;
      setBusy(true);
      setStatus(null);
      setDraft("");
      stickToBottom.current = true;
      setItems((prev) => [...prev, { kind: "user", text: message }]);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        });
        if (res.status === 401) {
          setSignedIn(false);
          return;
        }
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          note(body.error ?? "Something went wrong. Please try again.", "error");
          return;
        }
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        const parser = new SseParser();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const event of parser.push(value)) {
            if (event.type === "status") setStatus(event.label);
            else if (event.type === "auth_required") setSignedIn(false);
            else {
              if (event.type === "text" || event.type === "card" || event.type === "request") setStatus(null);
              setItems((prev) => appendEvent(prev, event));
            }
          }
        }
      } catch {
        note("The connection dropped. Reload to see the full reply.", "error");
      } finally {
        setBusy(false);
        setStatus(null);
      }
    },
    [locked, note],
  );

  // Posts one tap (Accept, Send request) and reports how it went. True when it worked.
  const act = useCallback(
    async (url: string, body: Record<string, string>, fallback: string): Promise<boolean> => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const reply = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
        if (res.status === 401) setSignedIn(false);
        if (reply.ok) {
          note(reply.message ?? "Done.", "ok");
          return true;
        }
        note(reply.message ?? reply.error ?? fallback, "error");
      } catch {
        note("The connection dropped. Please try again.", "error");
      }
      return false;
    },
    [note],
  );

  const accept = useCallback(
    async (productId: string) => {
      setAccepts((prev) => ({ ...prev, [productId]: "accepting" }));
      const ok = await act("/api/accept", { product_id: productId }, "Couldn't accept that. Please try again.");
      setAccepts((prev) => {
        const next = { ...prev };
        if (ok) next[productId] = "accepted";
        else delete next[productId];
        return next;
      });
    },
    [act],
  );

  const sendRequest = useCallback(
    async (requestId: string) => {
      setRequests((prev) => ({ ...prev, [requestId]: "sending" }));
      const ok = await act("/api/request", { request_id: requestId }, "Couldn't send that request. Please try again.");
      setRequests((prev) => {
        const next = { ...prev };
        if (ok) next[requestId] = "sent";
        else delete next[requestId];
        return next;
      });
    },
    [act],
  );

  const newChat = async () => {
    const res = await fetch("/api/chat", { method: "DELETE" }).catch(() => null);
    if (res?.ok) {
      setItems([]);
      setAccepts({});
      setRequests({});
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(draft);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter (the keyboard's "send" key on phones) sends; Shift+Enter adds a line. IME
    // composition is left alone.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  };

  const pickSuggestion = (text: string) => {
    if (signedIn) return void send(text);
    saveDraft(text);
    window.location.href = "/api/auth/login";
  };

  const shown = visibleItems(items);
  const showWelcome = signedIn === false || (signedIn && shown.length === 0 && !busy);

  return (
    <div className="app">
      <header className="header">
        <h1 className="brand">
          <span className="dot" aria-hidden="true" />
          Mynt
        </h1>
        {signedIn && (
          <div className="header-actions">
            <button type="button" className="ghost" onClick={newChat} disabled={locked}>
              New chat
            </button>
            <form method="post" action="/api/auth/logout">
              <button type="submit" className="ghost">
                Sign out
              </button>
            </form>
          </div>
        )}
      </header>

      <div className="scroll" ref={scrollRef} onScroll={onScroll}>
        <main className="column">
          {showWelcome && (
            <section className="welcome" aria-labelledby="welcome-title">
              <h2 id="welcome-title">Tell Mynt what you need.</h2>
              <p>Mynt finds a product that fits, or asks product teams to build one, and shows you the terms here.</p>
              {signedIn === false && (
                <a className="btn btn-primary signin" href="/api/auth/login">
                  Sign in to start
                </a>
              )}
              <ul className="chips" aria-label="Suggestions">
                {SUGGESTIONS.map((s) => (
                  <li key={s}>
                    <button type="button" className="chip" onClick={() => pickSuggestion(s)} disabled={locked}>
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="disclaimer">Mynt shows products and their terms; it doesn&apos;t give financial advice.</p>
            </section>
          )}

          <div className="messages" aria-live="polite" aria-relevant="additions">
            {shown.map((item, i) => {
              switch (item.kind) {
                case "user":
                  return (
                    <div key={i} className="bubble user">
                      {item.text}
                    </div>
                  );
                case "assistant":
                  return (
                    <div key={i} className="bubble assistant">
                      {item.text}
                    </div>
                  );
                case "note":
                  return (
                    <div key={i} className={`bubble note ${item.tone}`} role={item.tone === "error" ? "alert" : "status"}>
                      {item.text}
                    </div>
                  );
                case "card":
                  return (
                    <ProductCard
                      key={i}
                      card={item.card}
                      state={accepts[item.card.product_id] ?? "idle"}
                      disabled={locked}
                      onAccept={() => void accept(item.card.product_id)}
                      onMore={() => void send("Look for more options")}
                    />
                  );
                case "request":
                  return (
                    <RequestCard
                      key={i}
                      request={item.request}
                      state={requests[item.id] ?? "idle"}
                      disabled={locked}
                      onSend={() => void sendRequest(item.id)}
                      onDecline={() => void send("Don't send that request.")}
                    />
                  );
              }
            })}
            {busy && (
              <div className="status" role="status">
                <span className="typing" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span>{status ?? <span className="sr-only">Mynt is typing</span>}</span>
              </div>
            )}
          </div>
        </main>
      </div>

      {signedIn && (
        <footer className="composer">
          <form onSubmit={onSubmit}>
            <label htmlFor="message" className="sr-only">
              Message Mynt
            </label>
            <textarea
              id="message"
              ref={inputRef}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Message Mynt"
              enterKeyHint="send"
              autoComplete="off"
              maxLength={4000}
            />
            <button type="submit" className="send" disabled={locked || !draft.trim()}>
              Send
            </button>
          </form>
        </footer>
      )}
    </div>
  );
}
