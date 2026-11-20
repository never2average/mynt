"use client"

// The developer's connected GitHub repositories: up to five in the header's GitHub menu (with
// Connect repository; components/github-control.tsx), all of them on the Settings page's Repositories tab, each with its approval (approved, waiting for
// an admin and why, or rejected), and Connect repository, which calls connect_repository with an
// owner/name and shows what Mynt answered. The tab has one toolbar row (search, Status, Export
// CSV, Connect repository) over a paged table. Server-renderable for the tests.
import { useCallback, useEffect, useMemo, useState } from "react"
import { Download, ExternalLink, GitBranchPlus } from "lucide-react"

import { FilterSelect } from "@/components/filter-controls"
import { downloadCsv } from "@/components/licences-view"
import { ListLayout, matches, usePaged } from "@/components/list-layout"
import { dateOf } from "@/components/members-view"
import { StatusDot } from "@/components/promotion-view"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { toCsv } from "@/lib/compliance"
import { APPROVAL_LABELS, APPROVAL_TONE, connectResultText, REPOSITORY, type ConnectResult, type Repo, type RepoApproval } from "@/lib/repositories"

const STATUS_OPTIONS = (["approved", "pending", "rejected"] as RepoApproval[]).map((a) => ({ value: a, label: APPROVAL_LABELS[a] }))

export type ReposState = { kind: "loading" } | { kind: "unsupported" } | { kind: "error"; message: string } | { kind: "ready"; repos: Repo[]; connect: boolean }


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

/**
 * Connect repository: a labelled button and its dialog. Given `open` and `onOpenChange` (the
 * header's GitHub menu), the dialog is opened from outside and `trigger={false}` drops the button.
 */
export function ConnectRepository({
  enabled,
  onConnected,
  open: openProp,
  onOpenChange,
  trigger = true,
}: {
  enabled: boolean
  onConnected?: () => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  trigger?: boolean
}) {
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const setOpen = (o: boolean) => (onOpenChange ? onOpenChange(o) : setOpenState(o))
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

  // Opened from outside: start from an empty form.
  useEffect(() => {
    if (openProp) {
      setResult(null)
      setError(null)
    }
  }, [openProp])

  return (
    <>
      {trigger && <Button
        disabled={!enabled}
        onClick={() => {
          setOpen(true)
          setResult(null)
          setError(null)
        }}
        data-connect-repository
      >
        <GitBranchPlus />
        Connect repository
      </Button>}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Connect repository</DialogTitle>
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
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Repository
                <Input value={repository} onChange={(e) => setRepository(e.target.value)} placeholder="owner/name" aria-label="Repository (owner/name)" maxLength={200} />
              </label>
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

export function RepositoriesTab({ state, onConnected }: { state: ReposState; onConnected?: () => void }) {
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState("")
  const repos = useMemo(() => (state.kind === "ready" ? state.repos : []), [state])
  const rows = useMemo(() => repos.filter((r) => (!status || r.approval === status) && matches(query, r.repository, APPROVAL_LABELS[r.approval], r.note)), [repos, query, status])
  const { page, pages, shown, setPage } = usePaged(rows)
  if (state.kind === "loading")
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3" data-tab-panel="repositories" data-loading>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
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
  const exportCsv = () =>
    downloadCsv("repositories.csv", toCsv(["Repository", "Status", "Note", "Connected"], rows.map((r) => [r.repository, APPROVAL_LABELS[r.approval], r.note, r.connectedAt?.slice(0, 10) ?? null])))
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-tab-panel="repositories">
      <ListLayout
        search={query}
        onSearch={setQuery}
        searchLabel="Search repositories by name or status"
        actions={
          <>
            <FilterSelect label="Status" value={status} options={STATUS_OPTIONS} onChange={setStatus} />
            <Button variant="outline" onClick={exportCsv} disabled={!rows.length}>
              <Download />
              Export CSV
            </Button>
          </>
        }
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
