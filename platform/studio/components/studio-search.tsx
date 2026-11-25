"use client";

// The header's search: a search field that opens a Cmd+K modal, with Ask AI in the same modal
// (the field, or Cmd+K / Ctrl+K anywhere, opens it). Typing
// searches the studio: its pages, the selected workspace's apps (by name or stage), the user's own financial products, members,
// and audit actions, with the arrow keys and Enter (shadcn's Command, cmdk). "Ask AI"
// switches the modal to a conversation with the studio's assistant (components/ask-ai.tsx),
// streamed, with follow-ups, Stop and New chat; Search goes back. The conversation is kept in
// memory while the tab stays open (never in storage), so closing and reopening the modal keeps it.
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { Search, Sparkles } from "lucide-react";

import { AskAiPanel, type AskStatus } from "@/components/ask-ai";
import { useWorkspace } from "@/components/workspace-context";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  PLATFORM_SEARCH_GROUPS,
  platformSearchIndex,
  SEARCH_GROUPS,
  searchIndex,
  searchPlatform,
  searchStudio,
  type PlatformSearchSources,
  type SearchGroup,
  type SearchItem,
  type SearchSources,
} from "@/lib/studio-search";
import { myProductsFrom } from "@/lib/threads";
import { cn } from "@/lib/utils";
import { withWorkspace } from "@/lib/workspaces";
import { useStudioAccess } from "@/lib/use-liquidity-access";
import { askFetch, withoutReasoning } from "@/lib/ask-client";

export type SearchMode = "search" | "ai";

type SearchState = {
  open: boolean;
  setOpen: (open: boolean) => void;
  mode: SearchMode;
  setMode: (mode: SearchMode) => void;
  // Whether the modal offers Ask AI (the studio's does; the platform admin's searches only).
  askAi: boolean;
};

const Ctx = createContext<SearchState>({ open: false, setOpen: () => undefined, mode: "search", setMode: () => undefined, askAi: true });
export const useStudioSearch = () => useContext(Ctx);

/** The header's search field: opens the search modal. `compact`: an icon button (the app top bar). */
export function SearchTrigger({ compact = false, className }: { compact?: boolean; className?: string }) {
  const { setOpen, setMode, askAi } = useStudioSearch();
  const label = askAi ? "Search or ask AI" : "Search";
  const open = () => {
    setMode("search");
    setOpen(true);
  };
  if (compact)
    return (
      <Button type="button" variant="ghost" size="icon" className={cn("size-8", className)} onClick={open} aria-label={label} title={`${label} (⌘K)`} data-search-trigger>
        <Search />
      </Button>
    );
  return (
    <Button
      type="button"
      variant="outline"
      onClick={open}
      aria-label={label}
      data-search-trigger
      className={cn(
        "relative h-8 w-auto justify-start rounded-md bg-background text-sm font-normal text-muted-foreground shadow-none sm:pr-12 md:w-48 lg:w-64",
        className,
      )}
    >
      <Search className="mr-1" />
      <span className="hidden md:inline">{label}…</span>
      <span className="md:hidden">Search</span>
      <kbd className="pointer-events-none absolute top-1/2 right-1.5 hidden h-5 -translate-y-1/2 items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium select-none sm:flex">
        <span className="text-xs">⌘</span>K
      </kbd>
    </Button>
  );
}

/**
 * The search results inside the modal's Command: Ask AI first (with what was typed), then each
 * group's hits. Filtering is the studio's (searchStudio), so cmdk only moves the selection.
 */
export function SearchResults({
  items,
  query,
  askStatus,
  onSelect,
  onAsk,
  groups = SEARCH_GROUPS,
  search = searchStudio,
  empty = "Nothing in the studio matches that. Try Ask AI.",
}: {
  items: SearchItem[];
  query: string;
  // Without onAsk there's no Ask AI (the platform admin's search).
  askStatus?: AskStatus;
  onSelect: (item: SearchItem) => void;
  onAsk?: () => void;
  groups?: readonly SearchGroup[];
  search?: (items: SearchItem[], query: string) => SearchItem[];
  empty?: string;
}) {
  const results = useMemo(() => search(items, query), [search, items, query]);
  const off = askStatus === "disabled";
  return (
    <>
      {onAsk && (
        <CommandGroup heading="Ask AI">
          <CommandItem value="ask-ai" onSelect={onAsk} disabled={off} data-ask-ai>
            <Sparkles className="text-link" />
            <span className="truncate">{query.trim() ? `Ask AI: “${query.trim()}”` : "Ask AI about your apps"}</span>
            <CommandShortcut className="tracking-normal">{off ? "AI is not configured" : "Enter"}</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      )}
      {results.length === 0 && <CommandEmpty>{empty}</CommandEmpty>}
      {groups.map((group) => {
        const hits = results.filter((r) => r.group === group);
        if (!hits.length) return null;
        return (
          <CommandGroup key={group} heading={group}>
            {hits.map((item) => (
              <CommandItem key={item.id} value={item.id} onSelect={() => onSelect(item)} data-result={item.group}>
                <span className="truncate">{item.label}</span>
                {item.hint && <CommandShortcut className="tracking-normal">{item.hint}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        );
      })}
    </>
  );
}

const pick = async <T,>(url: string, read: (body: Record<string, unknown>) => T | undefined): Promise<T | undefined> => {
  const res = await fetch(url, { cache: "no-store" }).catch(() => null);
  if (!res?.ok) return undefined;
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return body ? read(body) : undefined;
};

// What search covers, for the selected workspace: loaded each time the modal opens.
function useSearchSources(open: boolean): SearchSources {
  const { selected, loading } = useWorkspace();
  // Apps, members and audit actions are developers' (their routes are developer-only).
  const access = useStudioAccess();
  const developer = access?.developer === true;
  // The platform admin's sections, only for Mynt admins (its pages are a 404 for anyone else).
  const admin = access?.admin === true;
  const [fetched, setSources] = useState<SearchSources>({});
  const sources = useMemo(() => ({ ...fetched, admin }), [fetched, admin]);
  useEffect(() => {
    if (!open || loading || !developer) return;
    let live = true;
    const ws = encodeURIComponent(selected.id);
    const set = (patch: SearchSources) => live && setSources((s) => ({ ...s, ...patch }));
    void pick(withWorkspace("/api/projects", selected), (b) => b.projects as SearchSources["apps"]).then((apps) => set({ apps: apps ?? [] }));
    // The user's own financial products: each opens its workspace.
    void pick("/api/products?mine=1", (b) => myProductsFrom(b.mine)).then((products) => set({ products: products ?? [] }));
    if (!selected.implicit)
      void pick(`/api/workspaces/${ws}/members`, (b) => b.members as SearchSources["members"]).then((members) => set({ members: members ?? [] }));
    else set({ members: [] });
    void pick(withWorkspace("/api/audit", selected), (b) => (b.page as { events?: { action: string }[] } | undefined)?.events).then((events) =>
      set({ auditActions: (events ?? []).map((e) => e.action) }),
    );
    return () => {
      live = false;
    };
  }, [open, loading, selected, developer]);
  return sources;
}

// Whether Ask AI can answer (GET /api/ask), checked whenever the modal opens.
function useAskStatus(open: boolean): AskStatus {
  const [status, setStatus] = useState<AskStatus>("loading");
  useEffect(() => {
    if (!open) return;
    let live = true;
    void fetch("/api/ask", { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as { enabled?: unknown } | null;
        if (live) setStatus(res.ok && body?.enabled === true ? "enabled" : "disabled");
      })
      .catch(() => live && setStatus("disabled"));
    return () => {
      live = false;
    };
  }, [open]);
  return status;
}

// Cmd+K / Ctrl+K anywhere toggles the modal.
function useSearchShortcut(setOpen: React.Dispatch<React.SetStateAction<boolean>>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setOpen]);
}

export function StudioSearchProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SearchMode>("search");
  useSearchShortcut(setOpen);

  const value = useMemo(() => ({ open, setOpen, mode, setMode, askAi: true }), [open, mode]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <StudioSearchDialog />
    </Ctx.Provider>
  );
}

// The platform admin's search (/platform, Mynt admins only): the same field and Cmd+K modal, searching its sections,
// every workspace and firm (the admin list routes, loaded the first time the modal opens) and the studio's pages.
// Across Mynt: no workspace is picked, so nothing here reads the studio's workspace. No Ask AI.
export function PlatformSearchProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SearchMode>("search");
  useSearchShortcut(setOpen);

  const value = useMemo(() => ({ open, setOpen, mode, setMode, askAi: false }), [open, mode]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <PlatformSearchDialog />
    </Ctx.Provider>
  );
}

// Every workspace and firm on Mynt, for the platform admin's search: fetched once, the first time the modal opens.
function usePlatformSearchSources(open: boolean): PlatformSearchSources {
  const [sources, setSources] = useState<PlatformSearchSources>({});
  const started = useRef(false);
  useEffect(() => {
    if (!open || started.current) return;
    started.current = true;
    const set = (patch: PlatformSearchSources) => setSources((s) => ({ ...s, ...patch }));
    void pick("/api/admin/workspaces", (b) => (Array.isArray(b.workspaces) ? (b.workspaces as PlatformSearchSources["workspaces"]) : undefined)).then((workspaces) =>
      set({ workspaces: workspaces ?? [] }),
    );
    void pick("/api/admin/firms", (b) => (Array.isArray(b.firms) ? (b.firms as PlatformSearchSources["firms"]) : undefined)).then((firms) => set({ firms: firms ?? [] }));
  }, [open]);
  return sources;
}

function PlatformSearchDialog() {
  const { open, setOpen } = useStudioSearch();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const sources = usePlatformSearchSources(open);
  const items = useMemo(() => platformSearchIndex(sources), [sources]);
  const go = (href: string) => {
    setOpen(false);
    setQuery("");
    router.push(href);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={false} className="gap-0 overflow-hidden p-0 sm:max-w-xl" data-search-mode="search" data-platform-search>
        <DialogTitle className="sr-only">Search the platform admin</DialogTitle>
        <DialogDescription className="sr-only">Search the platform admin&apos;s sections, workspaces, firms and the studio&apos;s pages.</DialogDescription>
        <Command shouldFilter={false} loop className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground">
          <CommandInput value={query} onValueChange={setQuery} placeholder="Search sections, workspaces, firms…" />
          <CommandList className="max-h-[min(60vh,26rem)]">
            <SearchResults items={items} query={query} groups={PLATFORM_SEARCH_GROUPS} search={searchPlatform} empty="Nothing in the platform admin matches that." onSelect={(i) => go(i.href)} />
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function StudioSearchDialog() {
  const { open, setOpen, mode, setMode } = useStudioSearch();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const sources = useSearchSources(open);
  const items = useMemo(() => searchIndex(sources), [sources]);
  const askStatus = useAskStatus(open);

  // The conversation lives here, so it outlasts the modal closing.
  // Failures come back as a sentence, never raw JSON (lib/ask-client.ts).
  const transport = useMemo(() => new DefaultChatTransport<UIMessage>({ api: "/api/ask", fetch: askFetch, prepareSendMessagesRequest: withoutReasoning }), []);
  const chat = useChat<UIMessage>({ id: "studio-ask-ai", transport });
  const pendingQuestion = useRef<string | null>(null);

  const close = useCallback(() => setOpen(false), [setOpen]);
  const go = (href: string) => {
    close();
    setQuery("");
    router.push(href);
  };
  const ask = () => {
    if (askStatus === "disabled") return;
    const q = query.trim();
    pendingQuestion.current = q || null;
    setQuery("");
    setMode("ai");
  };
  // The question typed in search is sent once the conversation is showing.
  useEffect(() => {
    if (mode !== "ai" || !pendingQuestion.current) return;
    const text = pendingQuestion.current;
    pendingQuestion.current = null;
    void chat.sendMessage({ text });
  }, [mode, chat]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setMode("search");
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn("gap-0 overflow-hidden p-0 sm:max-w-xl", mode === "ai" && "h-[min(42rem,85vh)] sm:max-w-3xl")}
        data-search-mode={mode}
      >
        <DialogTitle className="sr-only">{mode === "ai" ? "Ask AI" : "Search the studio"}</DialogTitle>
        <DialogDescription className="sr-only">
          {mode === "ai" ? "Ask about your apps, builds, workspaces and compliance." : "Search pages, apps, members and audit actions, or ask AI."}
        </DialogDescription>
        {mode === "search" ? (
          <Command shouldFilter={false} loop className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground">
            <CommandInput value={query} onValueChange={setQuery} placeholder="Search apps, pages, members… or ask AI" />
            <CommandList className="max-h-[min(60vh,26rem)]">
              <SearchResults items={items} query={query} askStatus={askStatus} onSelect={(i) => go(i.href)} onAsk={ask} />
            </CommandList>
          </Command>
        ) : (
          <AskAiPanel
            chat={chat}
            status={askStatus}
            onBack={() => setMode("search")}
            onClose={close}
            onNavigate={(href) => {
              close();
              setMode("search");
              router.push(href);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
