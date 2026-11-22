"use client"

// The Build page's Recent row (the few threads the user touched last, under the welcome) and its View all
// list: a centred pop-up like Search chats (components/chat-search.tsx) with a search box, a type filter
// (All · Apps · Financial products) and every thread, newest first. Each thread says what it is (App or
// Financial product), its name, when it last changed and its status (lib/threads.ts).
import { useMemo, useState } from "react"
import { AppWindow, Landmark, Search, type LucideIcon } from "lucide-react"

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { filterThreads, relativeTime, THREAD_FILTERS, THREAD_KIND_LABELS, type StudioThread, type ThreadFilter, type ThreadKind } from "@/lib/threads"
import { cn } from "@/lib/utils"

export const THREAD_ICONS: Record<ThreadKind, LucideIcon> = { app: AppWindow, product: Landmark }
export const RECENT_MAX = 6

export const threadAriaLabel = (t: Pick<StudioThread, "kind" | "name">) => `${THREAD_KIND_LABELS[t.kind]}: ${t.name}`

export function ThreadKindLabel({ kind, className }: { kind: ThreadKind; className?: string }) {
  const Icon = THREAD_ICONS[kind]
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground", className)} data-thread-kind={kind}>
      <Icon className="size-3.5" aria-hidden data-thread-icon={kind} />
      {THREAD_KIND_LABELS[kind]}
    </span>
  )
}

export function RecentThreads({ threads, onOpen, max = RECENT_MAX, now }: { threads: readonly StudioThread[]; onOpen: (t: StudioThread) => void; max?: number; now?: Date }) {
  const [all, setAll] = useState(false)
  if (!threads.length) return null
  const shown = threads.slice(0, Math.min(max, RECENT_MAX))
  return (
    <section className="mt-6 w-full max-w-2xl px-4" aria-label="Recent" data-recent>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Recent</h2>
        <button type="button" onClick={() => setAll(true)} className="rounded-md px-2 py-1 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground" data-view-all>
          View all
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3" data-recent-list>
        {shown.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => onOpen(t)}
            aria-label={threadAriaLabel(t)}
            title={`${THREAD_KIND_LABELS[t.kind]} · ${t.status}`}
            className="flex min-w-0 flex-col gap-1 rounded-lg border bg-background px-3 py-2 text-left transition-colors hover:bg-muted/50"
            data-recent-thread={t.key}
            data-kind={t.kind}
          >
            <ThreadKindLabel kind={t.kind} />
            <span className="truncate text-sm font-medium" data-thread-name>
              {t.name}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span data-thread-status>{t.status}</span>
              <span aria-hidden>·</span>
              <span data-thread-updated>{relativeTime(t.updatedAt, now)}</span>
            </span>
          </button>
        ))}
      </div>
      <ThreadsDialog open={all} onOpenChange={setAll} threads={threads} onOpen={onOpen} now={now} />
    </section>
  )
}

export function ThreadsDialog({ open, onOpenChange, threads, onOpen, now }: { open: boolean; onOpenChange: (open: boolean) => void; threads: readonly StudioThread[]; onOpen: (t: StudioThread) => void; now?: Date }) {
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<ThreadFilter>("all")
  const shown = useMemo(() => filterThreads(threads, query, filter), [threads, query, filter])
  const close = (next: boolean) => {
    if (!next) {
      setQuery("")
      setFilter("all")
    }
    onOpenChange(next)
  }
  const pick = (t: StudioThread) => {
    close(false)
    onOpen(t)
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex h-[65vh] w-full max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:w-[65vw] sm:max-w-[65vw]" aria-describedby={undefined} data-dialog="threads">
        <DialogTitle className="sr-only">All threads</DialogTitle>
        <div className="flex items-center gap-2 border-b px-4 py-3 pr-12">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && shown[0]) {
                e.preventDefault()
                pick(shown[0])
              }
            }}
            placeholder="Search threads"
            aria-label="Search threads"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            data-thread-search
          />
        </div>
        <div role="radiogroup" aria-label="Show" className="flex flex-wrap gap-1 border-b px-4 py-2" data-thread-filter>
          {THREAD_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={filter === f.id}
              data-state={filter === f.id ? "on" : "off"}
              onClick={() => setFilter(f.id)}
              className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground data-[state=on]:bg-muted data-[state=on]:text-foreground"
              data-filter={f.id}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-[minmax(8rem,auto)_1fr_auto_auto] gap-x-4 border-b px-6 py-2 text-xs font-medium text-muted-foreground" aria-hidden>
          <span>Type</span>
          <span>Name</span>
          <span>Status</span>
          <span className="w-24 text-right">Updated</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2" data-thread-rows>
          {shown.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => pick(t)}
              aria-label={threadAriaLabel(t)}
              className="grid w-full min-w-0 grid-cols-[minmax(8rem,auto)_1fr_auto_auto] items-center gap-x-4 rounded-md px-4 py-2 text-left hover:bg-muted"
              data-thread-row={t.key}
              data-kind={t.kind}
            >
              <ThreadKindLabel kind={t.kind} />
              <span className="truncate text-sm font-medium" title={t.name}>
                {t.name}
              </span>
              <span className="text-xs text-muted-foreground" data-thread-status>
                {t.status}
              </span>
              <span className="w-24 text-right text-xs text-muted-foreground" data-thread-updated>
                {relativeTime(t.updatedAt, now)}
              </span>
            </button>
          ))}
          {!shown.length && (
            <p className="px-4 py-2 text-sm text-muted-foreground" data-no-threads>
              {threads.length ? "No threads match." : "No threads yet."}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
