"use client"

// Put online: hosting the app's newest verified build on Mynt, from the app's top bar. The bar
// shows where the app stands (Online at its address, Deploying, Not online) and a labelled
// Put online button, which opens a sheet: the build, the repository and commit it deploys, and what
// happens (its own address; the Mynt key added at Mynt's edge, never on the app's machine). Confirm
// turns the workspace's hosting on if needed and deploys; the sheet then follows the deploy until
// the app answers. A build that pushed nowhere can't be hosted: the sheet says so and offers
// Choose repository for the app's next build. The builder chat's Put online (after a build ships)
// opens the same sheet. The views are server-renderable, so the tests render them without a browser.
import { useCallback, useEffect, useRef, useState } from "react"
import { CloudUpload, ExternalLink, FolderGit2 } from "lucide-react"

import { StatusDot } from "@/components/promotion-view"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import {
  deployable,
  MEMBERS_HOSTING,
  NO_REPOSITORY,
  ONLINE_LABELS,
  ONLINE_TONE,
  POLL_MS,
  putOnlineLabel,
  runsBuild,
  shortCommit,
  WHAT_HAPPENS,
  type AppOnline,
  type ShippedBuild,
  type WorkspaceHosting,
} from "@/lib/hosting"
import type { Repo } from "@/lib/repositories"

/** The builder chat's Put online asks the top bar to open its sheet (detail: { projectId }). */
export const PUT_ONLINE_EVENT = "mynt:put-online"

export type HostingMeta =
  | { supported: false }
  | {
      supported: true
      app: { id: string; name: string; workspaceId: string | null }
      role: string
      canTurnOn: boolean
      hosting: WorkspaceHosting
      build: ShippedBuild | null
      repository: { current: string | null; managed: boolean } | null
      repositories: Repo[] | null
      canChooseRepository: boolean
    }

// The route's answers, checked before they're drawn (anything else is ignored).
const isHosting = (v: unknown): v is WorkspaceHosting => {
  const h = v as { on?: unknown; app?: { state?: unknown } } | null
  return typeof h?.on === "boolean" && typeof h["app"]?.state === "string"
}
const isHostingMeta = (v: unknown): v is HostingMeta => {
  const m = v as { supported?: unknown; hosting?: unknown; app?: unknown } | null
  return m?.supported === false || (m?.supported === true && isHosting(m.hosting) && typeof m["app"] === "object" && m["app"] !== null)
}

const hostOf =(url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The app's state on Mynt's hosting, in words: Online at its address (a link), Deploying, Not online. */
export function OnlineMark({ online }: { online: AppOnline }) {
  if (online.state === "online" && online.url)
    return (
      <a href={online.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1 hover:underline" data-online-state="online">
        <StatusDot tone="green" label={`Online at ${hostOf(online.url)}`} className="min-w-0 truncate" />
      </a>
    )
  return <StatusDot tone={ONLINE_TONE[online.state]} label={ONLINE_LABELS[online.state]} data-online-state={online.state} />
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  )
}

export type PutOnlineViewProps = {
  meta: Extract<HostingMeta, { supported: true }>
  busy?: boolean
  error?: string | null
  result?: string | null
  onPutOnline: () => void
  onChooseRepository: (repository: string) => void
}

/** The sheet's body: the build, its repository and commit, what happens, then the state and the confirm. */
export function PutOnlineView({ meta, busy = false, error = null, result = null, onPutOnline, onChooseRepository }: PutOnlineViewProps) {
  const { build, hosting } = meta
  const online = hosting["app"]
  const [choice, setChoice] = useState<string>(meta.repositories?.[0]?.repository ?? "")
  if (!build)
    return (
      <p className="text-sm text-muted-foreground" data-no-shipped-build>
        {meta["app"].name} has no build that Mynt has verified yet. Ship a build from the chat; once Mynt verifies it, you can put it online here.
      </p>
    )
  const ready = deployable(build)
  const membersBlocked = !hosting.on && !meta.canTurnOn && !!meta["app"].workspaceId
  const already = runsBuild(online, build)
  return (
    <div className="flex flex-col gap-4" data-put-online-view>
      <dl className="flex flex-col gap-3 rounded-lg border p-3" data-build={build.id}>
        <Fact label="Build">{build.goal ?? build.id}</Fact>
        <Fact label="Repository">{build.repository ?? "None: this build wasn't pushed to a repository"}</Fact>
        <Fact label="Commit">{build.commitSha ? <code className="text-xs">{shortCommit(build.commitSha)}</code> : "None"}</Fact>
        <Fact label="Now">
          <OnlineMark online={online} />
          {online.state !== "not_online" && online.commitSha && online.buildId !== build.id && (
            <span className="ml-1 text-xs text-muted-foreground">(running commit {shortCommit(online.commitSha)}, an earlier build)</span>
          )}
        </Fact>
      </dl>

      {ready ? (
        <div className="flex flex-col gap-2" data-what-happens>
          <p className="text-sm font-medium">What happens</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {WHAT_HAPPENS.map((w) => (
              <li key={w}>{w}</li>
            ))}
            {!hosting.on && meta.canTurnOn && <li>Your workspace&apos;s hosting is turned on first; its apps all run on it.</li>}
          </ul>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-lg border p-3" data-no-repository>
          <p className="text-sm">{NO_REPOSITORY}</p>
          {meta.repository?.current && (
            <p className="text-sm text-muted-foreground" data-current-repository>
              The app&apos;s next build pushes to {meta.repository.current}
              {meta.repository.managed ? " (the repository Mynt keeps for it)" : ""}.
            </p>
          )}
          {meta.canChooseRepository && meta.repositories && meta.repositories.length > 0 ? (
            <form
              className="flex flex-col gap-2"
              data-choose-repository
              onSubmit={(e) => {
                e.preventDefault()
                if (choice) onChooseRepository(choice)
              }}
            >
              <label className="flex flex-col gap-1 text-sm">
                Your approved repositories
                <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={choice} onChange={(e) => setChoice(e.target.value)}>
                  {meta.repositories.map((r) => (
                    <option key={r.repository} value={r.repository}>
                      {r.repository}
                    </option>
                  ))}
                </select>
              </label>
              <div>
                <Button type="submit" variant="outline" size="sm" disabled={busy || !choice} data-set-repository>
                  <FolderGit2 />
                  Choose repository
                </Button>
              </div>
            </form>
          ) : meta.canChooseRepository ? (
            <p className="text-sm text-muted-foreground" data-no-approved-repositories>
              You have no approved repository yet. Connect one on the Settings page&apos;s Repositories tab; once it&apos;s approved, choose it here.
            </p>
          ) : null}
        </div>
      )}

      {membersBlocked && ready && (
        <p className="text-sm text-muted-foreground" data-members-note>
          {MEMBERS_HOSTING}
        </p>
      )}
      {online.state === "not_online" && online.error && (
        <div className="flex flex-col gap-1" data-deploy-error>
          <p className="text-sm font-medium">The last deploy stopped. Mynt says:</p>
          <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{online.error}</pre>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="text-sm font-medium" data-put-online-result>
          {result}
        </p>
      )}
      {online.state === "online" && online.url && already && (
        <Button asChild variant="outline" data-open-online>
          <a href={online.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink />
            Open {hostOf(online.url)}
          </a>
        </Button>
      )}
      {ready && !already && (
        <Button onClick={onPutOnline} disabled={busy || membersBlocked} data-confirm-put-online>
          <CloudUpload />
          {busy ? "Putting it online…" : putOnlineLabel(online, build)}
        </Button>
      )}
      {already && online.state === "deploying" && (
        <p className="text-sm text-muted-foreground" data-deploying-note>
          Deploying commit {shortCommit(online.commitSha)}. Mynt&apos;s hosting is building it; its address shows here once it answers.
        </p>
      )}
    </div>
  )
}

/** The top bar's Put online button: labelled, never icon-only. */
export function PutOnlineButton({ onClick, label = "Put online", compact = false }: { onClick: () => void; label?: string; compact?: boolean }) {
  return (
    <Button type="button" size="sm" variant="outline" className={compact ? "h-7 rounded-full" : "h-7"} onClick={onClick} data-put-online-button>
      <CloudUpload className="size-3.5" />
      {label}
    </Button>
  )
}

/** The builder chat's Put online, shown once the build has shipped (and only where this Mynt hosts apps): opens the top bar's sheet. */
export function ChatPutOnlineButton({ projectId }: { projectId: string }) {
  const [supported, setSupported] = useState(false)
  useEffect(() => {
    let live = true
    void (async () => {
      const res = await fetch(`/api/apps/${encodeURIComponent(projectId)}/hosting?only=status`, { cache: "no-store" }).catch(() => null)
      const body = (await res?.json().catch(() => null)) as { supported?: unknown; hosting?: unknown } | null
      if (live) setSupported(res?.ok === true && body?.supported === true && isHosting(body.hosting))
    })()
    return () => {
      live = false
    }
  }, [projectId])
  if (!supported) return null
  return <PutOnlineButton compact onClick={() => window.dispatchEvent(new CustomEvent(PUT_ONLINE_EVENT, { detail: { projectId } }))} />
}

/** The app top bar's hosting state and Put online, with its sheet. Hidden until this Mynt hosts apps. */
export function HostingControl({ appId, appName }: { appId: string; appName: string }) {
  const [meta, setMeta] = useState<HostingMeta | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const base = `/api/apps/${encodeURIComponent(appId)}/hosting`
  const live = useRef(true)

  const load = useCallback(async () => {
    const res = await fetch(base, { cache: "no-store" }).catch(() => null)
    const body = (await res?.json().catch(() => null)) as HostingMeta | null
    if (live.current && res?.ok && isHostingMeta(body)) setMeta(body)
  }, [base])

  useEffect(() => {
    live.current = true
    void load()
    // A build that ships (or any change to the app) can change what Put online offers.
    const onUpdated = () => void load()
    window.addEventListener("adorable:projects-updated", onUpdated)
    return () => {
      live.current = false
      window.removeEventListener("adorable:projects-updated", onUpdated)
    }
  }, [load])

  // The chat's Put online opens this sheet.
  useEffect(() => {
    const onPutOnline = (e: Event) => {
      if ((e as CustomEvent<{ projectId?: string }>).detail?.projectId !== appId) return
      setError(null)
      setResult(null)
      setOpen(true)
      void load()
    }
    window.addEventListener(PUT_ONLINE_EVENT, onPutOnline)
    return () => window.removeEventListener(PUT_ONLINE_EVENT, onPutOnline)
  }, [appId, load])

  // While it deploys, Mynt is asked again every few seconds until it answers or stops.
  const deploying = meta?.supported === true && meta.hosting["app"].state === "deploying"
  useEffect(() => {
    if (!deploying) return
    const t = window.setInterval(async () => {
      const res = await fetch(`${base}?only=status`, { cache: "no-store" }).catch(() => null)
      const body = (await res?.json().catch(() => null)) as { hosting?: WorkspaceHosting } | null
      if (!live.current || !res?.ok || !isHosting(body?.hosting)) return
      const hosting = body.hosting
      setMeta((m) => (m && m.supported ? { ...m, hosting } : m))
      if (hosting["app"].state === "online") setResult(hosting["app"].url ? `${appName} is online at ${hosting["app"].url}` : `${appName} is online.`)
      if (hosting["app"].state === "not_online") setResult(null)
    }, POLL_MS)
    return () => window.clearInterval(t)
  }, [deploying, base, appName])

  const send = async (payload: Record<string, unknown>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    setResult(null)
    const res = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => null)
    const body = (await res?.json().catch(() => null)) as { message?: string; hosting?: WorkspaceHosting } | null
    setBusy(false)
    if (!res) return setError("Couldn't reach the studio. Check your connection.")
    if (!res.ok) return setError(body?.message ?? "That didn't work. Please try again.")
    setResult(body?.message ?? "Done.")
    const hosting = body?.hosting
    if (isHosting(hosting)) setMeta((m) => (m && m.supported ? { ...m, hosting } : m))
    if (payload.action === "set_repository") void load()
  }

  if (!meta?.supported) return null
  const online = meta.hosting["app"]
  const offered = !!meta.build && !runsBuild(online, meta.build)
  return (
    <>
      <div className="flex shrink-0 items-center gap-2" data-hosting-control>
        <span className="hidden max-w-56 min-w-0 md:inline-flex">
          <OnlineMark online={online} />
        </span>
        {meta.build && (
          <PutOnlineButton
            onClick={() => {
              setError(null)
              setResult(null)
              setOpen(true)
            }}
            label={offered ? putOnlineLabel(online, meta.build) : "Hosting details"}
          />
        )}
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Put {appName} online</SheetTitle>
            <SheetDescription>Mynt hosts the build it verified, from the repository and commit below.</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            <PutOnlineView
              meta={meta}
              busy={busy}
              error={error}
              result={result}
              onPutOnline={() => meta.build && void send({ action: "put_online", build_id: meta.build.id })}
              onChooseRepository={(repository) => void send({ action: "set_repository", repository })}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
