"use client"

// Search chats: a centred pop-up (about two thirds of the screen) with a search box at the top and the
// user's chats under it, newest first; typing narrows them to the ones whose title or words match, each
// with the words around the match. Up/Down move, Enter opens. Used by the Earn chat's Past conversations
// button and by the sidebar's Search chats (open or collapsed).

import { useMemo, useState } from "react"
import { Plus, Search } from "lucide-react"

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { searchThreads, threadDate, type EarnThreadRecord } from "@/lib/earn-history"

export function ChatSearchDialog({
  open,
  onOpenChange,
  threads,
  current = null,
  onPick,
  onNew,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  threads: EarnThreadRecord[]
  current?: string | null
  onPick: (id: string) => void
  onNew: () => void
}) {
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const matches = useMemo(() => searchThreads(threads, query), [threads, query])
  // Row 0 is New conversation; the chats follow.
  const rows = matches.length + 1
  const close = (next: boolean) => {
    if (!next) {
      setQuery("")
      setActive(0)
    }
    onOpenChange(next)
  }
  const choose = (i: number) => {
    if (i === 0) onNew()
    else onPick(matches[i - 1].thread.id)
    close(false)
  }
  const rowClass = "flex w-full min-w-0 items-start gap-3 rounded-md px-3 py-2 text-left data-[active=true]:bg-muted hover:bg-muted"

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="flex h-[65vh] w-full max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:w-[65vw] sm:max-w-[65vw]"
        aria-describedby={undefined}
        data-dialog="history"
      >
        <DialogTitle className="sr-only">Search chats</DialogTitle>
        <div className="flex items-center gap-2 border-b px-4 py-3 pr-12">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault()
                setActive((a) => Math.min(rows - 1, a + 1))
              } else if (e.key === "ArrowUp") {
                e.preventDefault()
                setActive((a) => Math.max(0, a - 1))
              } else if (e.key === "Enter") {
                e.preventDefault()
                choose(active)
              }
            }}
            placeholder="Search chats"
            aria-label="Search chats"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            data-chat-search
          />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2" data-thread-list>
          <button type="button" className={rowClass} data-active={active === 0} onMouseEnter={() => setActive(0)} onClick={() => choose(0)} data-new-conversation>
            <Plus className="mt-0.5 size-4 shrink-0" />
            <span className="text-sm font-medium">New conversation</span>
          </button>
          {threads.length > 0 && (
            <div className="px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground" data-list-heading>
              {query.trim() ? `${matches.length} ${matches.length === 1 ? "chat" : "chats"}` : "Recent"}
            </div>
          )}
          {matches.map(({ thread: t, snippet }, i) => (
            <button
              key={t.id}
              type="button"
              className={rowClass}
              data-active={active === i + 1}
              aria-current={t.id === current ? "true" : undefined}
              onMouseEnter={() => setActive(i + 1)}
              onClick={() => choose(i + 1)}
              data-thread={t.id}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium" title={t.title} data-thread-title>
                  {t.title}
                </span>
                {snippet && (
                  <span className="truncate text-xs text-muted-foreground" data-thread-snippet>
                    {snippet}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground" data-thread-date>
                {threadDate(t.updatedAt)}
              </span>
            </button>
          ))}
          {!threads.length && (
            <p className="px-3 py-2 text-sm text-muted-foreground" data-history-empty>
              No past conversations yet.
            </p>
          )}
          {threads.length > 0 && query.trim() !== "" && !matches.length && (
            <p className="px-3 py-2 text-sm text-muted-foreground" data-no-matches>
              No chats match “{query.trim()}”.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
