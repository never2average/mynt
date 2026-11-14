"use client";

// The header's search: a search field that opens a Cmd+K modal, with Ask AI in the same modal
// (the field, or Cmd+K / Ctrl+K anywhere, opens it). Typing
// searches the studio: its pages, the selected workspace's apps (by name or stage), members,
// licences and audit actions, with the arrow keys and Enter (shadcn's Command, cmdk). "Ask AI"
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
import { SEARCH_GROUPS, searchIndex, searchStudio, type SearchItem, type SearchSources } from "@/lib/studio-search";
import { cn } from "@/lib/utils";

export type SearchMode = "search" | "ai";

type SearchState = {
  open: boolean;
  setOpen: (open: boolean) => void;
  mode: SearchMode;
  setMode: (mode: SearchMode) => void;
};

const Ctx = createContext<SearchState>({ open: false, setOpen: () => undefined, mode: "search", setMode: () => undefined });
export const useStudioSearch = () => useContext(Ctx);

/** The header's search field: opens the search modal. `compact`: an icon button (the app top bar). */
export function SearchTrigger({ compact = false, className }: { compact?: boolean; className?: string }) {
  const { setOpen, setMode } = useStudioSearch();
  const open = () => {
    setMode("search");
    setOpen(true);
  };
  if (compact)
    return (
      <Button type="button" variant="ghost" size="icon" className={cn("size-8", className)} onClick={open} aria-label="Search or ask AI" title="Search or ask AI (⌘K)" data-search-trigger>
        <Search />
      </Button>
    );
  return (
    <Button
      type="button"
      variant="outline"
      onClick={open}
      aria-label="Search or ask AI"
      data-search-trigger
      className={cn(
        "relative h-8 w-auto justify-start rounded-md bg-background text-sm font-normal text-muted-foreground shadow-none sm:pr-12 md:w-48 lg:w-64",
        className,
      )}
    >
      <Search className="mr-1" />
      <span className="hidden md:inline">Search or ask AI…</span>
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
}: {
  items: SearchItem[];
  query: string;
  askStatus: AskStatus;
  onSelect: (item: SearchItem) => void;
  onAsk: () => void;
}) {
  const results = useMemo(() => searchStudio(items, query), [items, query]);
  const off = askStatus === "disabled";
  return (
    <>
      <CommandGroup heading="Ask AI">
        <CommandItem value="ask-ai" onSelect={onAsk} disabled={off} data-ask-ai>
          <Sparkles className="text-primary" />
          <span className="truncate">{query.trim() ? `Ask AI: “${query.trim()}”` : "Ask AI about your apps"}</span>
          <CommandShortcut className="tracking-normal">{off ? "AI is not configured" : "Enter"}</CommandShortcut>
        </CommandItem>
      </CommandGroup>
      {results.length === 0 && <CommandEmpty>Nothing in the studio matches that. Try Ask AI.</CommandEmpty>}
      {SEARCH_GROUPS.map((group) => {
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
  const [sources, setSources] = useState<SearchSources>({});
  useEffect(() => {
    if (!open || loading) return;
    let live = true;
    const ws = encodeURIComponent(selected.id);
    const set = (patch: SearchSources) => live && setSources((s) => ({ ...s, ...patch }));
    void pick(`/api/projects?workspace=${ws}`, (b) => b.projects as SearchSources["apps"]).then((apps) => set({ apps: apps ?? [] }));
    if (!selected.implicit)
      void pick(`/api/workspaces/${ws}/members`, (b) => b.members as SearchSources["members"]).then((members) => set({ members: members ?? [] }));
    else set({ members: [] });
    void pick(`/api/licences?workspace=${ws}`, (b) => b.licences as SearchSources["licences"]).then((licences) => set({ licences: licences ?? [] }));
    void pick(`/api/audit?workspace=${ws}`, (b) => (b.page as { events?: { action: string }[] } | undefined)?.events).then((events) =>
      set({ auditActions: (events ?? []).map((e) => e.action) }),
    );
    return () => {
      live = false;
    };
  }, [open, loading, selected.id, selected.implicit]);
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

export function StudioSearchProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SearchMode>("search");

  // Cmd+K / Ctrl+K anywhere toggles the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const value = useMemo(() => ({ open, setOpen, mode, setMode }), [open, mode]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <StudioSearchDialog />
    </Ctx.Provider>
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
  const transport = useMemo(() => new DefaultChatTransport<UIMessage>({ api: "/api/ask" }), []);
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
          {mode === "ai" ? "Ask about your apps, builds, workspaces and compliance." : "Search pages, apps, members, licences and audit actions, or ask AI."}
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
