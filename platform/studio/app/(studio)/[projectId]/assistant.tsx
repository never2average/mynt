"use client";

import { AssistantRuntimeProvider, useAuiState } from "@assistant-ui/react";
import {
  useAISDKRuntime,
  AssistantChatTransport,
} from "@assistant-ui/react-ai-sdk";
import { useChat } from "@ai-sdk/react";
import { type UIMessage } from "ai";
import { Thread } from "@/components/assistant-ui/thread";
import { CapField, HeldMessage, ShipButton, useCapChoice } from "@/components/build-controls";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { APP_TABS, PANEL_TAB_EVENT, type AppTab } from "@/lib/app-panel";
import { canShip, FINISHED, startsNewBuild, type BuildState } from "@/lib/chat";
import type { SlashCommand } from "@/lib/slash-commands";

type ThreadState = {
  isEmpty: boolean;
  isRunning: boolean;
};

type BuildData = { buildId: string; started: boolean; session?: boolean };
type FollowData = { buildId: string; after: number | null; shipping?: boolean };
/** A message sent while the app's build was shipping or being verified: sent once that ends. */
export type HeldData = { buildId: string; text: string; after: number | null };

// The slash menu's /ship (and the Ship button) ask the builder chat to ship its session build.
export const SHIP_EVENT = "mynt:ship-build";

// Where the chat follows a build on from (GET /api/chat): the build, and the activity cursor it
// has shown up to. `shipping`: Ship was just pressed, so the reply first says what that does.
export function followUrl(projectId: string, buildId: string, after: number | null, shipping = false): string {
  const q = new URLSearchParams({ projectId, buildId });
  if (after !== null) q.set("after", String(after));
  if (shipping) q.set("shipping", "1");
  return `/api/chat?${q.toString()}`;
}

// A held message is kept per app in this browser, so a reload doesn't lose it.
export const heldKey = (projectId: string) => `mynt:held-message:${projectId}`;
export function readHeld(projectId: string): HeldData | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(heldKey(projectId)) ?? "null") as Partial<HeldData> | null;
    return v && typeof v.buildId === "string" && typeof v.text === "string" && v.text ? { buildId: v.buildId, text: v.text, after: typeof v.after === "number" ? v.after : null } : null;
  } catch {
    return null;
  }
}
function writeHeld(projectId: string, held: HeldData | null) {
  try {
    if (held) window.localStorage.setItem(heldKey(projectId), JSON.stringify(held));
    else window.localStorage.removeItem(heldKey(projectId));
  } catch {
    // Storage blocked: the message is still held for as long as the page is open.
  }
}

const EMPTY_MESSAGES: UIMessage[] = [];

const TAB_DESCRIPTIONS: Record<AppTab, string> = {
  preview: "Show the app's live preview",
  pnl: "Open the app's P&L",
  licences: "Open the licences behind the app",
  security: "Open the app's security checks",
  sdk: "Open the app's SDK",
  activity: "Open the app's activity",
};

// The builder chat's slash commands: open a panel tab (the workspace shell listens for
// "adorable:panel-tab"), ship the session build, or start a message to the coding agent. There's
// no /new: a message with no build selected may still steer the app's running build, so the chat
// can't promise a fresh one.
export const builderCommands = (projectId: string): SlashCommand[] => [
  ...APP_TABS.map((tab) => ({
    name: tab,
    description: TAB_DESCRIPTIONS[tab],
    run: () => window.dispatchEvent(new CustomEvent(PANEL_TAB_EVENT, { detail: { projectId, tab } })),
  })),
  {
    name: "ship",
    description: "Ship the build: the agent wraps up, then Mynt verifies and ships it",
    run: () => window.dispatchEvent(new CustomEvent(SHIP_EVENT, { detail: { projectId } })),
  },
  { name: "fix", description: "Ask the coding agent to fix something", template: "Fix " },
  { name: "add", description: "Ask the coding agent to add a feature", template: "Add " },
];

// Mynt Studio: Adorable's chat panel, talking to Mynt's coding agent. Adorable's /api/chat ran
// its own model; the studio's sends each message to Mynt, which steers the app's running build
// or starts one, and streams back what the agent does. Each build is one conversation.
export const Assistant = ({
  initialMessages,
  follow = null,
  build = null,
  selectedProjectId,
  selectedConversationId = null,
  onThreadStateChange,
  welcome,
}: {
  initialMessages?: UIMessage[];
  /** The build is still going: follow it live from this cursor as the page opens. */
  follow?: { after: number } | null;
  /** The conversation's build as the page loaded it (its status, session, shipping). */
  build?: BuildState | null;
  selectedProjectId: string;
  selectedConversationId?: string | null;
  onThreadStateChange?: (next: ThreadState) => void;
  welcome?: ReactNode;
}) => {
  return (
    <ProjectAssistant
      key={`${selectedProjectId}:${selectedConversationId ?? "new"}`}
      projectId={selectedProjectId}
      conversationId={selectedConversationId}
      initialMessages={initialMessages ?? EMPTY_MESSAGES}
      follow={follow}
      initialBuild={build}
      onThreadStateChange={onThreadStateChange}
      welcome={welcome}
    />
  );
};

function ProjectAssistant({
  projectId,
  conversationId,
  initialMessages,
  follow,
  initialBuild,
  onThreadStateChange,
  welcome,
}: {
  projectId: string;
  conversationId: string | null;
  initialMessages: UIMessage[];
  follow: { after: number } | null;
  initialBuild: BuildState | null;
  onThreadStateChange?: (next: ThreadState) => void;
  welcome?: ReactNode;
}) {
  // The build this conversation is about; set by the first reply when a message starts one.
  const activeBuildIdRef = useRef<string | null>(conversationId);
  // Where to follow the build on from, and whether the reply that just ended asked to be followed
  // on (a watch ends after a few minutes, or when the agent hands over to Mynt's verification).
  const followRef = useRef<FollowData | null>(conversationId && follow ? { buildId: conversationId, after: follow.after } : null);
  const followOnRef = useRef(false);
  // What the composer shows: Ship while a session is open, a cap for the next build, a held message.
  const [build, setBuild] = useState<BuildState | null>(initialBuild);
  const cursorRef = useRef<number | null>(follow?.after ?? null);
  const [held, setHeldState] = useState<HeldData | null>(null);
  const heldRef = useRef<HeldData | null>(null);
  const setHeld = useCallback(
    (h: HeldData | null) => {
      heldRef.current = h;
      setHeldState(h);
      writeHeld(projectId, h);
    },
    [projectId],
  );
  // Builds Mynt has said are over (a follow answered 204): a message held for one is sent.
  const [ended, setEnded] = useState<Set<string>>(() => new Set());
  const [shipNote, setShipNote] = useState<string | null>(null);
  const [shipping, setShipping] = useState(false);
  const [cap, setCap] = useState<number | null>(null);
  const capRef = useRef<number | null>(null);

  const dispatchProjectsUpdated = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("adorable:projects-updated", { detail: { projectId } }),
    );
  }, [projectId]);

  const handleData = useCallback(
    (part: { type: string; data?: unknown }) => {
      if (part.type === "data-follow") {
        const f = part.data as Partial<FollowData> | undefined;
        if (typeof f?.buildId !== "string") return;
        followRef.current = { buildId: f.buildId, after: typeof f.after === "number" ? f.after : null };
        followOnRef.current = true;
        return;
      }
      if (part.type === "data-state") {
        const s = part.data as Partial<BuildState & { after: number | null }> | undefined;
        if (typeof s?.buildId !== "string" || typeof s.status !== "string") return;
        const next = { buildId: s.buildId, status: s.status, session: s.session === true, finishing: s.finishing === true };
        // Ship pressed here is known before Mynt's state says so.
        setBuild((prev) => ({ ...next, finishing: next.finishing || (prev?.buildId === next.buildId && prev.finishing && !FINISHED.has(next.status)) }));
        if (typeof s.after === "number") cursorRef.current = s.after;
        return;
      }
      if (part.type === "data-hold") {
        const h = part.data as Partial<HeldData> | undefined;
        if (typeof h?.buildId !== "string" || typeof h.text !== "string") return;
        setHeld({ buildId: h.buildId, text: h.text, after: typeof h.after === "number" ? h.after : null });
        return;
      }
      if (part.type !== "data-build") return;
      const data = part.data as BuildData | undefined;
      if (!data?.buildId) return;
      if (data.started) setBuild({ buildId: data.buildId, status: "queued", session: data.session === true, finishing: false });
      if (data.buildId === activeBuildIdRef.current) return;
      activeBuildIdRef.current = data.buildId;
      // Show this build's address and preview without reloading the chat.
      window.history.replaceState(
        window.history.state,
        "",
        `/${projectId}/${data.buildId}`,
      );
      window.dispatchEvent(
        new CustomEvent("adorable:active-conversation", {
          detail: { projectId, conversationId: data.buildId },
        }),
      );
      dispatchProjectsUpdated();
    },
    [projectId, dispatchProjectsUpdated, setHeld],
  );

  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: async (options) => ({
          body: {
            // Only the new message: Mynt keeps the conversation, and the server reads just this.
            messages: options.messages.slice(-1),
            projectId,
            conversationId: activeBuildIdRef.current,
            // Used only if the message starts a build.
            ...(capRef.current !== null ? { capUsd: capRef.current } : {}),
          },
        }),
        // Following a build on: no message, just what the agent and Mynt do next.
        prepareReconnectToStreamRequest: async ({ headers, credentials }) => {
          const f = followRef.current;
          return { api: f ? followUrl(projectId, f.buildId, f.after, f.shipping) : followUrl(projectId, activeBuildIdRef.current ?? "", null), headers, credentials };
        },
        // A follow answered 204: that build is over (a message held for it can go now).
        fetch: async (input, init) => {
          const res = await fetch(input, init);
          if ((init?.method ?? "GET") === "GET" && res.status === 204) {
            const id = new URL(String(input), window.location.origin).searchParams.get("buildId");
            if (id) setEnded((prev) => new Set(prev).add(id));
          }
          return res;
        },
      }),
    [projectId],
  );

  const chatRef = useRef<{ resumeStream: () => Promise<void> } | null>(null);
  const onFinish = useCallback(
    ({ isAbort, isError }: { isAbort?: boolean; isError?: boolean }) => {
      dispatchProjectsUpdated();
      const again = followOnRef.current && !isAbort && !isError;
      followOnRef.current = false;
      // After the chat has settled, so the follow is a request of its own.
      if (again) window.setTimeout(() => void chatRef.current?.resumeStream(), 0);
    },
    [dispatchProjectsUpdated],
  );

  const chat = useChat<UIMessage>({
    id: `${projectId}:${conversationId ?? "new"}`,
    transport,
    messages: initialMessages,
    onData: handleData,
    onFinish,
  });
  chatRef.current = chat;

  // A build that's still going is followed as soon as its page opens; so is the build a held
  // message waits for (after a reload), from where the message was held.
  const followed = useRef(false);
  useEffect(() => {
    if (followed.current) return;
    followed.current = true;
    const kept = readHeld(projectId);
    if (kept) {
      heldRef.current = kept;
      setHeldState(kept);
      if (!followRef.current || followRef.current.buildId !== kept.buildId) followRef.current = { buildId: kept.buildId, after: kept.after };
    }
    if (followRef.current) void chat.resumeStream();
  }, [chat, projectId]);

  // Verification has ended (shipped or not): the held message goes, as the next request.
  const idle = chat.status === "ready" || chat.status === "error";
  useEffect(() => {
    const h = heldRef.current;
    if (!h || !idle) return;
    const over = ended.has(h.buildId) || (build?.buildId === h.buildId && FINISHED.has(build.status));
    if (!over) return;
    setHeld(null);
    void chat.sendMessage({ text: h.text });
  }, [idle, ended, build, chat, setHeld, held]);

  // Ship (the button, or /ship): finish_build through the studio. It never interrupts the agent's
  // current request, so it's offered whenever the session is open. The chat then follows the
  // build to its end, starting with what shipping does.
  const ship = useCallback(async () => {
    const b = build;
    if (!b || !canShip(b) || shipping) {
      if (!b || !canShip(b)) setShipNote("There's no build waiting for your next message to ship.");
      return;
    }
    setShipping(true);
    setShipNote(null);
    try {
      const res = await fetch(`/api/builds/${encodeURIComponent(b.buildId)}/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok) {
        setShipNote(data?.message ?? "Couldn't ship the build. Please try again.");
        return;
      }
      setBuild({ ...b, finishing: true });
      followRef.current = { buildId: b.buildId, after: cursorRef.current, shipping: true };
      if (chat.status === "ready" || chat.status === "error") void chat.resumeStream();
      else followOnRef.current = true; // the reply under way ends, then the chat follows on
    } catch {
      setShipNote("Couldn't reach the studio. Check your connection.");
    } finally {
      setShipping(false);
    }
  }, [build, shipping, projectId, chat]);
  useEffect(() => {
    const onShip = (e: Event) => {
      if ((e as CustomEvent<{ projectId?: string }>).detail?.projectId === projectId) void ship();
    };
    window.addEventListener(SHIP_EVENT, onShip);
    return () => window.removeEventListener(SHIP_EVENT, onShip);
  }, [ship, projectId]);

  // The cap for a message that starts a build: read when one would, and again after each build ends.
  const newBuild = startsNewBuild(build) && !held;
  const choice = useCapChoice(projectId, `${newBuild}:${build?.status ?? ""}`, newBuild);
  const capChoiceShown = newBuild ? choice : null;
  useEffect(() => {
    const next = capChoiceShown && !capChoiceShown.blocked ? (cap === null ? capChoiceShown.startUsd : Math.min(Math.max(cap, capChoiceShown.minUsd), capChoiceShown.maxUsd)) : null;
    capRef.current = next;
    if (next !== cap) setCap(next);
  }, [capChoiceShown, cap]);

  const runtime = useAISDKRuntime(chat);
  const commands = useMemo(() => builderCommands(projectId), [projectId]);

  const toolbar = (
    <>
      {canShip(build) && <ShipButton onShip={() => void ship()} busy={shipping} />}
      {capChoiceShown && cap !== null && <CapField choice={capChoiceShown} value={cap} onChange={(v) => setCap(v)} />}
    </>
  );
  const note = held ? (
    <HeldMessage text={held.text} onRemove={() => setHeld(null)} />
  ) : capChoiceShown?.blocked ? (
    <span data-cap-blocked>{capChoiceShown.blocked}</span>
  ) : (
    shipNote
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadStateBridge
        projectId={projectId}
        onThreadStateChange={onThreadStateChange}
      />
      <Thread welcome={welcome} commands={commands} toolbar={toolbar} note={note} inputDisabled={!!capChoiceShown?.blocked} />
    </AssistantRuntimeProvider>
  );
}

function ThreadStateBridge({
  projectId,
  onThreadStateChange,
}: {
  projectId: string | null;
  onThreadStateChange?: (next: ThreadState) => void;
}) {
  const isEmpty = useAuiState(({ thread }) => thread.isEmpty);
  const isRunning = useAuiState(({ thread }) => thread.isRunning);

  useEffect(() => {
    onThreadStateChange?.({ isEmpty, isRunning });
    window.dispatchEvent(
      new CustomEvent("adorable:thread-state", {
        detail: { projectId, isRunning },
      }),
    );
  }, [isEmpty, isRunning, onThreadStateChange, projectId]);

  return null;
}
