"use client"

// The developer's connected GitHub repositories: up to five on the dashboard's GitHub tile, all
// of them on the Settings page's Repositories tab, each with its approval (approved, waiting for
// an admin and why, or rejected), and Connect repository, which calls connect_repository with an
// owner/name and shows what Mynt answered. Server-renderable for the tests.
import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"
import { ExternalLink, GitBranchPlus } from "lucide-react"

import { ListLayout, matches, usePaged } from "@/components/list-layout"
import { dateOf } from "@/components/members-view"
import { StatusDot } from "@/components/promotion-view"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { APPROVAL_LABELS, APPROVAL_TONE, connectResultText, REPOSITORY, type ConnectResult, type Repo } from "@/lib/repositories"

export type ReposState = { kind: "loading" } | { kind: "unsupported" } | { kind: "error"; message: string } | { kind: "ready"; repos: Repo[]; connect: boolean }

export const TILE_REPOS = 5

/** Loads the developer's repositories (/api/repositories); `reload` after connecting one. */
export function useRepositories(): { state: ReposState; reload: () => void } {
  const [state, setState] = useState<ReposState>({ kind: "loading" })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    void (async () => {
      const res = await fetch("/api/repositories", { cache: "no-store" }).catch(() => null)
      const body = (await res?.json().catch(() => null)) as { supported?: boolean; connect?: boolean; repositories?: Repo[]; message?: string } | null
      if (!live) return
      if (!res?.ok || !body) setState({ kind: "error", message: body?.message ?? "Couldn't load your repositories." })
      else if (body.supported === false) setState({ kind: "unsupported" })
      else setState({ kind: "ready", repos: body.repositories ?? [], connect: body.connect === true })
    })()
    return () => {
      live = false
    }
  }, [tick])
  return { state, reload: useCallback(() => setTick((t) => t + 1), []) }
}

export function RepoStatus({ repo }: { repo: Repo }) {
  return <StatusDot tone={APPROVAL_TONE[repo.approval]} label={APPROVAL_LABELS[repo.approval]} />
}

/** What Mynt answered: approved now, sent to an admin (with why and the GitHub link), or install the app first. */
export function ConnectResultView({ result }: { result: ConnectResult }) {
  const link = result.kind === "install" ? result.installUrl : result.kind === "pending" || result.kind === "rejected" ? result.manageUrl : null
  return (
    <div role="status" className="flex flex-col gap-2 text-sm" data-connect-result={result.kind}>
      <p className="font-medium">{connectResultText(result)}</p>
      {link && (
        <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium hover:underline">
          {result.kind === "install" ? "Install the GitHub App" : "Link your GitHub account"}
          <ExternalLink className="size-3.5" />
        </a>
      )}
      {result.kind === "pending" && result.manageUrl && (
        <p className="text-muted-foreground">Once your GitHub account is linked and can push to it, connect it again to be approved at once.</p>
      )}
    </div>
  )
}

/** Connect repository: a labelled button and its dialog. */
export function ConnectRepository({ enabled, onConnected }: { enabled: boolean; onConnected?: () => void }) {
  const [open, setOpen] = useState(false)
  const [repository, setRepository] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ConnectResult | null>(null)
  const [busy, setBusy] = useState(false)
  const valid = REPOSITORY.test(repository.trim())

  const connect = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const res = await fetch("/api/repositories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repository: repository.trim() }) }).catch(() => null)
    const body = (await res?.json().catch(() => null)) as { result?: ConnectResult; message?: string } | null
    setBusy(false)
    if (res?.ok && body?.result) {
      setResult(body.result)
      onConnected?.()
    } else setError(body?.message ?? "Couldn't connect it. Please try again.")
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={!enabled}
        title={enabled ? undefined : "Connecting repositories comes with Mynt's next update"}
        onClick={() => {
          setOpen(true)
          setResult(null)
          setError(null)
        }}
        data-connect-repository
      >
        <GitBranchPlus />
        Connect repository
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Connect repository</DialogTitle>
            <DialogDescription>
              Lets Mynt&apos;s coding agent push branches and open pull requests on one of your GitHub repositories. If your linked GitHub account can push to it,
              it&apos;s approved at once; otherwise an admin decides.
            </DialogDescription>
          </DialogHeader>
          {result ? (
            <>
              <ConnectResultView result={result} />
              <DialogFooter>
                <Button onClick={() => setOpen(false)}>Done</Button>
              </DialogFooter>
            </>
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                void connect()
              }}
            >
              <Input value={repository} onChange={(e) => setRepository(e.target.value)} placeholder="owner/name" aria-label="Repository (owner/name)" maxLength={200} />
              {repository.trim() && !valid && <p className="text-sm text-muted-foreground">Enter it as owner/name, like octo-org/savings-app.</p>}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!valid || busy}>
                  Connect repository
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

/** The GitHub tile's list: up to five repositories with their status, then View all. */
export function RepoTileList({ state }: { state: ReposState }) {
  if (state.kind === "loading") return <p className="text-xs text-muted-foreground">Loading repositories…</p>
  if (state.kind === "unsupported") return <p className="text-xs text-muted-foreground" data-repos="unsupported">Connected repositories aren&apos;t available yet</p>
  if (state.kind === "error") return <p className="text-xs text-destructive">{state.message}</p>
  if (!state.repos.length) return <p className="text-xs text-muted-foreground" data-repos="none">No repositories connected yet</p>
  return (
    <div className="flex w-full flex-col gap-1.5" data-repos="list">
      <ul className="flex flex-col gap-1.5">
        {state.repos.slice(0, TILE_REPOS).map((r) => (
          <li key={r.repository} className="flex flex-col gap-0.5" data-repo={r.repository} data-approval={r.approval}>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-xs text-foreground">{r.repository}</span>
              <RepoStatus repo={r} />
            </div>
            {r.approval !== "approved" && r.note && <span className="text-xs text-muted-foreground">{r.note}</span>}
          </li>
        ))}
      </ul>
      <Link href="/settings?tab=repositories" className="text-xs font-medium text-foreground hover:underline">
        View all{state.repos.length > TILE_REPOS ? ` (${state.repos.length})` : ""}
      </Link>
    </div>
  )
}

export function RepositoriesTab({ state, onConnected }: { state: ReposState; onConnected?: () => void }) {
  const [query, setQuery] = useState("")
  const repos = state.kind === "ready" ? state.repos : []
  const rows = useMemo(() => repos.filter((r) => matches(query, r.repository, APPROVAL_LABELS[r.approval], r.note)), [repos, query])
  const { page, pages, shown, setPage } = usePaged(rows)
  if (state.kind === "loading") return <p className="text-sm text-muted-foreground">Loading repositories…</p>
  if (state.kind === "error")
    return (
      <p role="alert" className="text-sm text-destructive">
        {state.message}
      </p>
    )
  if (state.kind === "unsupported")
    return (
      <p className="rounded-lg border border-dashed px-6 py-10 text-center text-sm text-muted-foreground" data-tab-panel="repositories" data-empty="not-available">
        Connected repositories aren&apos;t available yet. They come with Mynt&apos;s next update.
      </p>
    )
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-tab-panel="repositories">
      <p className="text-sm text-muted-foreground">Your own GitHub repositories that builds can push to, in every workspace. Apps&apos; Mynt-managed repositories aren&apos;t listed.</p>
      <ListLayout
        search={query}
        onSearch={setQuery}
        searchLabel="Search repositories by name or status"
        cta={<ConnectRepository enabled={state.connect} onConnected={onConnected} />}
        page={page}
        pages={pages}
        total={rows.length}
        onPage={setPage}
      >
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Repository</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Note</TableHead>
              <TableHead>Connected</TableHead>
              <TableHead className="text-right">Links</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length ? (
              shown.map((r) => (
                <TableRow key={r.repository} data-repo-row={r.repository}>
                  <TableCell className="font-mono text-xs">{r.repository}</TableCell>
                  <TableCell>
                    <RepoStatus repo={r} />
                  </TableCell>
                  <TableCell className="max-w-80 text-muted-foreground">{r.note ?? (r.approval === "pending" ? "An admin hasn't decided yet" : "No note")}</TableCell>
                  <TableCell className="text-muted-foreground">{dateOf(r.connectedAt) ?? "Not recorded"}</TableCell>
                  <TableCell className="text-right">
                    <Button asChild size="sm" variant="outline">
                      <a href={`https://github.com/${r.repository}`} target="_blank" rel="noopener noreferrer">
                        Open on GitHub
                      </a>
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  {repos.length ? "No repository matches the search." : "No repositories connected yet."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </ListLayout>
    </div>
  )
}
