"use client"

// Earn's table tabs (/earn's right-hand panel, beside the assistant: components/earn-assistant.tsx),
// by role, each a table with a full-width search, labelled filters and its own CTA:
// - My pools (builders): their products' pools, each one's state, terms, latest verified
//   health and withdrawal queue; "Propose pool" on a sponsored component of their firm's product.
// - Opportunities (liquidity providers): pools open to commitments, their health and terms, and
//   "Commit capital".
// - My positions (liquidity providers): committed, settled, queued and paid, "Request
//   withdrawal", and the firm's requests in each pool's queue.
// Nothing here moves money: Mynt records a request, and the pool's sponsor moves the money on its
// approved rail. Server-renderable for the tests.
import { useMemo, useState } from "react"
import { Search } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  commitRefusal,
  filterPools,
  healthText,
  limitsText,
  NO_POOL_FILTERS,
  noticeText,
  pageOf,
  parseUsd,
  percentOfBps,
  poolCommitBlock,
  proposalFrom,
  railsApproved,
  reserveText,
  STAGE_LABELS,
  stageOf,
  statusText,
  US_STATE_CODES,
  usd,
  withdrawalRefusal,
  withdrawalTerms,
  type LiquidityData,
  type PoolFilters,
  type PoolRow,
  type PoolStage,
  type Position,
  type ProposeInput,
  type Sponsored,
  type Withdrawal,
} from "@/lib/liquidity"

// What Earn says about money, everywhere it shows pools: where money moves today, what's coming,
// and that it explains terms rather than recommending anything. No yields or returns are shown.
export const EARN_DISCLOSURE =
  "Money moves only on rails a pool's sponsoring licence provider approved, and Mynt never holds your funds or keys. An on-chain USDC treasury per app is coming (on devnet first). Real commitments wait until a Mynt admin clears a pool's offering; sandbox pools move test money only. Earn explains pool terms and matches them to what you ask: it isn't investment advice and shows no promised returns, only figures Mynt measures."

export type ActionResult = { ok: true; reply: unknown } | { error: string; refused?: boolean }
export type LiquidityActions = {
  propose(input: ProposeInput): Promise<ActionResult>
  commit(input: { pool_id: string; amount_cents: number; state: string; idempotency_key: string }): Promise<ActionResult>
  withdraw(input: { pool_id: string; amount_cents: number; idempotency_key: string }): Promise<ActionResult>
}
export type OpenForm = { kind: "propose" } | { kind: "commit"; poolId?: string } | { kind: "withdraw"; poolId?: string } | null

const selectClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
export const newIdempotencyKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "")
const dateOf = (iso: string | null) => (iso ? iso.slice(0, 10) : "—")
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

export function StageBadge({ stage }: { stage: PoolStage }) {
  const cls =
    stage === "cleared"
      ? "border-emerald-500/60"
      : stage === "uncleared"
        ? "border-amber-500/60"
        : stage === "sandbox"
          ? "border-sky-500/60"
          : "border-dashed"
  return (
    <Badge variant="outline" className={`${cls} whitespace-normal text-left`} data-stage={stage}>
      {STAGE_LABELS[stage]}
    </Badge>
  )
}

export function Money({ sandbox }: { sandbox: boolean }) {
  return (
    <Badge variant="outline" data-money={sandbox ? "sandbox" : "real"}>
      {sandbox ? "Sandbox" : "Real money"}
    </Badge>
  )
}

function Pager({ page, pages, onPage, total }: { page: number; pages: number; onPage: (p: number) => void; total: number }) {
  return (
    <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground" data-pager>
      <span className="tabular-nums">
        {total} in all · page {page + 1} of {pages}
      </span>
      <Button size="sm" variant="outline" disabled={page === 0} onClick={() => onPage(page - 1)}>
        Previous
      </Button>
      <Button size="sm" variant="outline" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
        Next
      </Button>
    </div>
  )
}

function SearchBox({ value, onChange, label, placeholder }: { value: string; onChange: (v: string) => void; label: string; placeholder: string }) {
  return (
    <div className="relative min-w-64 flex-1">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="pl-8" aria-label={label} />
    </div>
  )
}

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  )
}

function StageFilters({ f, setF, pools, stages, productLines }: { f: PoolFilters; setF: (f: PoolFilters) => void; pools: PoolRow[]; stages: PoolStage[]; productLines: boolean }) {
  const lines = [...new Set(pools.map((p) => p.productLine).filter((v): v is string => Boolean(v)))].sort()
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {productLines && (
        <select className={selectClass} value={f.productLine} onChange={(e) => setF({ ...f, productLine: e.target.value })} aria-label="Product line">
          <option value="">All product lines</option>
          {lines.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      )}
      <select className={selectClass} value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value as PoolFilters["stage"] })} aria-label="State">
        <option value="">All states</option>
        {stages.map((s) => (
          <option key={s} value={s}>
            {STAGE_LABELS[s]}
          </option>
        ))}
      </select>
      <select className={selectClass} value={f.money} onChange={(e) => setF({ ...f, money: e.target.value as PoolFilters["money"] })} aria-label="Sandbox or real">
        <option value="">Sandbox and real</option>
        <option value="sandbox">Sandbox only</option>
        <option value="real">Real money only</option>
      </select>
    </div>
  )
}

// ---- the builder ----

export function ProposeForm({ options, actions, onDone }: { options: Sponsored[]; actions: LiquidityActions; onDone: (message: string) => void }) {
  const [option, setOption] = useState(0)
  const [name, setName] = useState("")
  const [sandbox, setSandbox] = useState(true)
  const [reservePercent, setReservePercent] = useState("20")
  const [reserveFloor, setReserveFloor] = useState("0")
  const [noticeDays, setNoticeDays] = useState("30")
  const [minCommit, setMinCommit] = useState("1000")
  const [maxCommit, setMaxCommit] = useState("100000")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const picked = options[option] ?? null
  const input = proposalFrom({ option: picked, name, sandbox, reservePercent, reserveFloor, noticeDays, minCommit, maxCommit }, options)
  const sponsor = picked?.sponsorName ?? "The sponsoring licence provider"

  return (
    <Card data-form="propose">
      <CardHeader>
        <CardTitle>Propose a pool</CardTitle>
        <CardDescription>
          A pool starts paused. {sponsor} must approve it and name the money rails its capital moves on before it takes any commitment. Real (non-sandbox) commitments also wait until a Mynt admin
          clears the pool&apos;s offering.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault()
            if ("error" in input || busy) return setError("error" in input ? input.error : null)
            setBusy(true)
            void actions.propose(input).then((r) => {
              setBusy(false)
              if ("error" in r) return setError(r.error)
              onDone(`Pool "${input.name}" proposed. It's waiting for ${sponsor} to approve it and name its rails.`)
            })
          }}
        >
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            Sponsored component
            <select className={selectClass} value={option} onChange={(e) => setOption(Number(e.target.value))} aria-label="Sponsored component">
              {options.map((o, i) => (
                <option key={`${o.productId}|${o.componentKey}|${o.sponsorId}`} value={i}>
                  {o.productName} · {o.componentKey} · sponsored by {o.sponsorName ?? o.sponsorId}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            Pool name
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} aria-label="Pool name" />
          </label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} aria-label="Sandbox pool" />
            Sandbox pool: test money only, no real money moves
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Minimum reserve (% of obligations)
            <Input value={reservePercent} onChange={(e) => setReservePercent(e.target.value)} inputMode="decimal" aria-label="Minimum reserve percent" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Reserve floor (USD)
            <Input value={reserveFloor} onChange={(e) => setReserveFloor(e.target.value)} inputMode="decimal" aria-label="Reserve floor" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Notice period (days)
            <Input value={noticeDays} onChange={(e) => setNoticeDays(e.target.value)} inputMode="numeric" aria-label="Notice period days" />
          </label>
          <span />
          <label className="flex flex-col gap-1 text-sm">
            Smallest position per firm (USD)
            <Input value={minCommit} onChange={(e) => setMinCommit(e.target.value)} inputMode="decimal" aria-label="Smallest position" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Largest position per firm (USD)
            <Input value={maxCommit} onChange={(e) => setMaxCommit(e.target.value)} inputMode="decimal" aria-label="Largest position" />
          </label>
          <div className="flex items-center gap-2 sm:col-span-2">
            <Button type="submit" disabled={busy || "error" in input}>
              Propose pool
            </Button>
            {"error" in input ? <span className="text-sm text-muted-foreground">{input.error}</span> : null}
          </div>
          {error && <Alert>{error}</Alert>}
        </form>
      </CardContent>
    </Card>
  )
}

function BuilderPools({ pools, proposable, withdrawalsShown, actions, form, setForm }: { pools: PoolRow[]; proposable: Sponsored[] | null; withdrawalsShown: boolean; actions: LiquidityActions; form: OpenForm; setForm: (f: OpenForm) => void }) {
  const [f, setF] = useState<PoolFilters>(NO_POOL_FILTERS)
  const [page, setPage] = useState(0)
  const [done, setDone] = useState<string | null>(null)
  const shown = useMemo(() => filterPools(pools, f), [pools, f])
  const view = pageOf(shown, page)
  const proposeBlock = proposable === null ? "Proposing pools comes with Mynt's next update." : proposable.length ? null : "A licence provider must sponsor a component of one of your products before it can have a pool."

  return (
    <div className="flex flex-col gap-4" data-tab-panel="my-pools">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={f.query} onChange={(query) => (setF({ ...f, query }), setPage(0))} label="Search pools" placeholder="Search pool, product or component" />
        <Button onClick={() => setForm(form?.kind === "propose" ? null : { kind: "propose" })} disabled={Boolean(proposeBlock)} title={proposeBlock ?? undefined} data-cta="propose">
          Propose pool
        </Button>
      </div>
      <StageFilters f={f} setF={(n) => (setF(n), setPage(0))} pools={pools} stages={["awaiting_approval", "sandbox", "uncleared", "cleared"]} productLines={false} />
      <p className="text-sm text-muted-foreground" data-sponsor-note>
        {proposeBlock ??
          "Pools can be proposed only on a component an approved licence provider sponsors. Each one waits for that sponsor to approve it and name its deposit and withdrawal rails; real commitments also wait for a Mynt admin to clear the offering."}
      </p>
      {done && <p className="text-sm" role="status">{done}</p>}
      {form?.kind === "propose" && proposable?.length ? (
        <ProposeForm
          options={proposable}
          actions={actions}
          onDone={(m) => {
            setDone(m)
            setForm(null)
          }}
        />
      ) : null}
      <div className="overflow-auto rounded-lg border">
        <Table>
          <TableHeader className="bg-card">
            <TableRow>
              <TableHead>Pool</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Rails</TableHead>
              <TableHead>Minimum reserve</TableHead>
              <TableHead>Notice</TableHead>
              <TableHead>Commitment limits</TableHead>
              <TableHead>Committed / settled</TableHead>
              <TableHead>Latest health</TableHead>
              <TableHead className="text-right">Withdrawal queue</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.items.length ? (
              view.items.map((p) => (
                <TableRow key={p.id} data-pool={p.id}>
                  <TableCell>
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.productName ?? p.productId}
                      {p.componentKey ? ` · ${p.componentKey}` : ""}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StageBadge stage={stageOf(p)} />
                  </TableCell>
                  <TableCell className="max-w-56 whitespace-normal">{statusText(p)}</TableCell>
                  <TableCell>{railsApproved(p) ? "Deposit and withdrawal rails approved" : "None yet"}</TableCell>
                  <TableCell className="whitespace-normal">{reserveText(p)}</TableCell>
                  <TableCell>{noticeText(p.noticePeriodDays)}</TableCell>
                  <TableCell className="tabular-nums">{limitsText(p)}</TableCell>
                  <TableCell className="text-muted-foreground" title="Mynt shows a pool's capital to its liquidity providers and sponsor, not yet to its builder">
                    Not shown to builders yet
                  </TableCell>
                  <TableCell className="whitespace-normal" data-health>
                    {healthText(p.health)}
                    {p.health?.latestVerifiedEnd && !p.health.verified ? <div className="text-xs text-muted-foreground">Last verified to {dateOf(p.health.latestVerifiedEnd)}</div> : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums" data-queue>
                    {withdrawalsShown && p.queueLength !== null ? p.queueLength : "Not available yet"}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                  {pools.length ? "No pools match these filters." : "No pools yet. Propose one on a sponsored component of your product."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <Pager page={view.page} pages={view.pages} total={shown.length} onPage={setPage} />
    </div>
  )
}

// ---- the liquidity provider ----

// What Mynt answered a commitment with, in words: a deposit asked for on the pool's approved rail,
// never a transfer done.
export function commitOutcome(reply: unknown, sandbox: boolean): string {
  const r = isObj(reply) ? reply : {}
  const id = typeof r.movement_id === "string" ? r.movement_id : null
  const status = typeof r.movement_status === "string" ? r.movement_status : null
  return [
    `Deposit requested${id ? ` (movement ${id}${status ? `, ${status}` : ""})` : ""}.`,
    "Mynt doesn't hold your money: the pool's sponsor moves it on the pool's approved deposit rail and reports when it settles. Your position counts it only once it has settled.",
    sandbox ? "Sandbox pool: no real money moves." : "",
  ]
    .filter(Boolean)
    .join(" ")
}

export function withdrawalOutcome(reply: unknown, sandbox: boolean): string {
  const r = isObj(reply) ? reply : {}
  const seq = typeof r.seq === "number" ? r.seq : null
  const eligible = typeof r.eligible_at === "string" ? r.eligible_at : null
  return [
    `Added to the withdrawal queue${seq !== null ? ` as request #${seq}` : ""}${eligible ? `, payable from ${dateOf(eligible)} at the earliest` : ""}.`,
    "It's paid in queue order, and only as far as the pool's latest verified health snapshot keeps it above its minimum reserve.",
    sandbox ? "Sandbox pool: no real money moves." : "",
  ]
    .filter(Boolean)
    .join(" ")
}

export function CommitForm({ pools, positions, poolId, canCommit, actions, onDone, newKey = newIdempotencyKey }: { pools: PoolRow[]; positions: Position[]; poolId?: string; canCommit: boolean; actions: LiquidityActions; onDone: (message: string) => void; newKey?: () => string }) {
  const [id, setId] = useState(poolId ?? pools.find((p) => !poolCommitBlock(p, positions.find((x) => x.poolId === p.id)))?.id ?? pools[0]?.id ?? "")
  const [amount, setAmount] = useState("")
  const pool = pools.find((p) => p.id === id) ?? null
  const position = positions.find((p) => p.poolId === id) ?? null
  const [state, setState] = useState(position?.state ?? "")
  const [key, setKey] = useState(newKey)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const cents = parseUsd(amount)
  const refusal = !canCommit ? "Committing capital comes with Mynt's next update." : pool ? commitRefusal(pool, position, cents) : "Pick a pool."
  const lockedState = position?.state ?? null
  const chosenState = lockedState ?? state
  const change = (f: () => void) => {
    f()
    setKey(newKey())
    setError(null)
  }

  return (
    <Card data-form="commit">
      <CardHeader>
        <CardTitle>Commit capital</CardTitle>
        <CardDescription>
          This asks for a deposit on the pool&apos;s approved rail. Mynt never holds your funds: the pool&apos;s sponsor moves the money and reports when it settles, and your position counts only
          what has settled.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (refusal || !pool || cents === null || !chosenState || busy) return
            setBusy(true)
            void actions.commit({ pool_id: pool.id, amount_cents: cents, state: chosenState, idempotency_key: key }).then((r) => {
              setBusy(false)
              if ("error" in r) {
                if (r.refused) setKey(newKey())
                return setError(r.error)
              }
              onDone(commitOutcome(r.reply, pool.sandbox))
            })
          }}
        >
          <label className="flex flex-col gap-1 text-sm sm:col-span-3">
            Pool
            <select className={selectClass} value={id} onChange={(e) => change(() => setId(e.target.value))} aria-label="Pool">
              {pools.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {STAGE_LABELS[stageOf(p)]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Amount (USD)
            <Input value={amount} onChange={(e) => change(() => setAmount(e.target.value))} inputMode="decimal" placeholder="10,000.00" aria-label="Amount" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            US state your capital moves from
            <select className={selectClass} value={chosenState} disabled={Boolean(lockedState)} onChange={(e) => change(() => setState(e.target.value))} aria-label="US state">
              <option value="">Choose a state</option>
              {US_STATE_CODES.map((s) => (
                <option key={s} value={s}>
                  {s.slice(3).toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <Button type="submit" disabled={busy || Boolean(refusal) || !chosenState} data-submit="commit">
              Commit capital
            </Button>
          </div>
          {pool && (
            <p className="text-sm text-muted-foreground sm:col-span-3" data-terms>
              {limitsText(pool)}; notice period {noticeText(pool.noticePeriodDays).toLowerCase()}; minimum reserve {reserveText(pool)}.
              {position ? ` Your position now: ${usd(position.settledCents)} settled, ${usd(position.pendingInCents)} on its way in.` : ""}
              {lockedState ? " Your state is fixed while you hold a position here." : ""}
            </p>
          )}
          {refusal && amount !== "" ? (
            <p className="text-sm text-amber-600 dark:text-amber-300 sm:col-span-3" data-refusal>
              {refusal}
            </p>
          ) : refusal && pool && poolCommitBlock(pool, position) ? (
            <p className="text-sm text-amber-600 dark:text-amber-300 sm:col-span-3" data-refusal>
              {refusal}
            </p>
          ) : null}
          {error && <Alert>{error}</Alert>}
        </form>
      </CardContent>
    </Card>
  )
}

export function WithdrawForm({ positions, pools, poolId, canWithdraw, actions, onDone, newKey = newIdempotencyKey }: { positions: Position[]; pools: PoolRow[]; poolId?: string; canWithdraw: boolean; actions: LiquidityActions; onDone: (message: string) => void; newKey?: () => string }) {
  const [id, setId] = useState(poolId ?? positions.find((p) => p.availableCents > 0)?.poolId ?? positions[0]?.poolId ?? "")
  const [amount, setAmount] = useState("")
  const [key, setKey] = useState(newKey)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const position = positions.find((p) => p.poolId === id) ?? null
  const pool = pools.find((p) => p.id === id) ?? null
  const cents = parseUsd(amount)
  const refusal = !canWithdraw ? "Withdrawals come with Mynt's next update." : withdrawalRefusal(position, cents)

  return (
    <Card data-form="withdraw">
      <CardHeader>
        <CardTitle>Request withdrawal</CardTitle>
        <CardDescription data-withdraw-terms>{withdrawalTerms(pool?.noticePeriodDays ?? null)}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (refusal || !position || cents === null || busy) return
            setBusy(true)
            void actions.withdraw({ pool_id: position.poolId, amount_cents: cents, idempotency_key: key }).then((r) => {
              setBusy(false)
              if ("error" in r) {
                if (r.refused) setKey(newKey())
                return setError(r.error)
              }
              onDone(withdrawalOutcome(r.reply, position.sandbox))
            })
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            Pool
            <select
              className={selectClass}
              value={id}
              onChange={(e) => {
                setId(e.target.value)
                setKey(newKey())
              }}
              aria-label="Pool"
            >
              {positions.map((p) => (
                <option key={p.poolId} value={p.poolId}>
                  {p.name} · {usd(p.availableCents)} available
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Amount (USD)
            <Input
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value)
                setKey(newKey())
              }}
              inputMode="decimal"
              aria-label="Amount"
            />
          </label>
          <div className="flex items-end">
            <Button type="submit" disabled={busy || Boolean(refusal)} data-submit="withdraw">
              Request withdrawal
            </Button>
          </div>
          {pool && <p className="text-sm text-muted-foreground sm:col-span-3">Notice period: {noticeText(pool.noticePeriodDays).toLowerCase()}.</p>}
          {refusal && (amount !== "" || !position || position.availableCents <= 0) ? (
            <p className="text-sm text-amber-600 dark:text-amber-300 sm:col-span-3" data-refusal>
              {refusal}
            </p>
          ) : null}
          {error && <Alert>{error}</Alert>}
        </form>
      </CardContent>
    </Card>
  )
}

function OpenPools({ pools, positions, canCommit, actions, form, setForm }: { pools: PoolRow[]; positions: Position[]; canCommit: boolean; actions: LiquidityActions; form: OpenForm; setForm: (f: OpenForm) => void }) {
  const [f, setF] = useState<PoolFilters>(NO_POOL_FILTERS)
  const [page, setPage] = useState(0)
  const [done, setDone] = useState<string | null>(null)
  const shown = useMemo(() => filterPools(pools, f), [pools, f])
  const view = pageOf(shown, page)
  const position = (id: string) => positions.find((p) => p.poolId === id)
  const anyOpen = pools.some((p) => !poolCommitBlock(p, position(p.id)))

  return (
    <div className="flex flex-col gap-4" data-tab-panel="opportunities">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={f.query} onChange={(query) => (setF({ ...f, query }), setPage(0))} label="Search open pools" placeholder="Search pool, product or product line" />
        <Button onClick={() => setForm(form?.kind === "commit" ? null : { kind: "commit" })} disabled={!canCommit || !anyOpen} title={!canCommit ? "Committing capital comes with Mynt's next update" : !anyOpen ? "No pool is taking commitments right now" : undefined} data-cta="commit">
          Commit capital
        </Button>
      </div>
      <StageFilters f={f} setF={(n) => (setF(n), setPage(0))} pools={pools} stages={["sandbox", "cleared", "uncleared"]} productLines />
      {done && <p className="text-sm" role="status">{done}</p>}
      {form?.kind === "commit" && pools.length ? (
        <CommitForm
          key={form.poolId ?? "any"}
          pools={pools}
          positions={positions}
          poolId={form.poolId}
          canCommit={canCommit}
          actions={actions}
          onDone={(m) => {
            setDone(m)
            setForm(null)
          }}
        />
      ) : null}
      <div className="overflow-auto rounded-lg border">
        <Table>
          <TableHeader className="bg-card">
            <TableRow>
              <TableHead>Pool</TableHead>
              <TableHead>Product line</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Health</TableHead>
              <TableHead>Minimum reserve</TableHead>
              <TableHead>Notice</TableHead>
              <TableHead>Commitment limits</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.items.length ? (
              view.items.map((p) => {
                const blocked = !canCommit ? "Committing capital comes with Mynt's next update" : poolCommitBlock(p, position(p.id))
                return (
                  <TableRow key={p.id} data-pool={p.id}>
                    <TableCell>
                      <div className="font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">{p.productName ?? p.productId}</div>
                    </TableCell>
                    <TableCell>{p.productLine ?? "—"}</TableCell>
                    <TableCell>
                      <StageBadge stage={stageOf(p)} />
                    </TableCell>
                    <TableCell className="max-w-56 whitespace-normal">{statusText(p)}</TableCell>
                    <TableCell className="whitespace-normal" data-health>
                      {healthText(p.health)}
                      {p.health?.coverageBps !== null && p.health?.coverageBps !== undefined ? <div className="text-xs text-muted-foreground">Coverage {percentOfBps(p.health.coverageBps)}</div> : null}
                    </TableCell>
                    <TableCell className="whitespace-normal">{reserveText(p)}</TableCell>
                    <TableCell>{noticeText(p.noticePeriodDays)}</TableCell>
                    <TableCell className="tabular-nums">{limitsText(p)}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="outline" disabled={Boolean(blocked)} title={blocked ?? undefined} onClick={() => setForm({ kind: "commit", poolId: p.id })} data-commit={p.id}>
                        Commit capital
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })
            ) : (
              <TableRow>
                <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                  {pools.length ? "No pools match these filters." : "No pools are open to commitments yet."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <Pager page={view.page} pages={view.pages} total={shown.length} onPage={setPage} />
    </div>
  )
}

function MyPositions({ positions, withdrawals, pools, canWithdraw, actions, form, setForm }: { positions: Position[]; withdrawals: Withdrawal[]; pools: PoolRow[]; canWithdraw: boolean; actions: LiquidityActions; form: OpenForm; setForm: (f: OpenForm) => void }) {
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(0)
  const [done, setDone] = useState<string | null>(null)
  const q = query.trim().toLowerCase()
  const shown = positions.filter((p) => !q || p.name.toLowerCase().includes(q) || p.productId.toLowerCase().includes(q))
  const view = pageOf(shown, page)
  const anyAvailable = positions.some((p) => p.availableCents > 0)

  return (
    <div className="flex flex-col gap-4" data-tab-panel="my-positions">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={query} onChange={(v) => (setQuery(v), setPage(0))} label="Search positions" placeholder="Search pool or product" />
        <Button onClick={() => setForm(form?.kind === "withdraw" ? null : { kind: "withdraw" })} disabled={!canWithdraw || !anyAvailable} title={!canWithdraw ? "Withdrawals come with Mynt's next update" : !anyAvailable ? "Nothing settled is available to withdraw" : undefined} data-cta="withdraw">
          Request withdrawal
        </Button>
      </div>
      {done && <p className="text-sm" role="status">{done}</p>}
      {form?.kind === "withdraw" && positions.length ? (
        <WithdrawForm
          key={form.poolId ?? "any"}
          positions={positions}
          pools={pools}
          poolId={form.poolId}
          canWithdraw={canWithdraw}
          actions={actions}
          onDone={(m) => {
            setDone(m)
            setForm(null)
          }}
        />
      ) : null}
      <div className="overflow-auto rounded-lg border">
        <Table>
          <TableHeader className="bg-card">
            <TableRow>
              <TableHead>Pool</TableHead>
              <TableHead>Money</TableHead>
              <TableHead className="text-right">Committed</TableHead>
              <TableHead className="text-right">Settled</TableHead>
              <TableHead className="text-right">Queued</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead className="text-right">Available</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.items.length ? (
              view.items.map((p) => (
                <TableRow key={p.poolId} data-position={p.poolId}>
                  <TableCell>
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.productId}
                      {p.state ? ` · from ${p.state.slice(3).toUpperCase()}` : ""}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Money sandbox={p.sandbox} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums" title="Settled in, plus what's still on its way in">
                    {usd(p.committedCents)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{usd(p.settledCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{usd(p.queuedCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{usd(p.paidCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{usd(p.availableCents)}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" disabled={!canWithdraw || p.availableCents <= 0} onClick={() => setForm({ kind: "withdraw", poolId: p.poolId })} data-withdraw={p.poolId}>
                      Request withdrawal
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  {positions.length ? "No positions match this search." : "No positions yet. Commit capital to an open pool to start one."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <Pager page={view.page} pages={view.pages} total={shown.length} onPage={setPage} />

      <h3 className="mt-2 text-sm font-medium">Your withdrawal requests</h3>
      <div className="overflow-auto rounded-lg border">
        <Table>
          <TableHeader className="bg-card">
            <TableRow>
              <TableHead>Pool</TableHead>
              <TableHead>Place in queue</TableHead>
              <TableHead className="text-right">Asked</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Payable from</TableHead>
              <TableHead>Why it&apos;s waiting</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {withdrawals.length ? (
              withdrawals.map((w) => (
                <TableRow key={w.id} data-withdrawal={w.id}>
                  <TableCell>
                    {w.poolName ?? w.poolId} {w.sandbox ? <Money sandbox /> : null}
                  </TableCell>
                  <TableCell className="tabular-nums">{w.seq !== null ? `#${w.seq}` : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{usd(w.amountCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{usd(w.settledCents)}</TableCell>
                  <TableCell className="capitalize">{w.status.replace(/_/g, " ")}</TableCell>
                  <TableCell>{dateOf(w.eligibleAt)}</TableCell>
                  <TableCell className="max-w-64 whitespace-normal text-muted-foreground">{w.waitingReason ?? "—"}</TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                  No withdrawal requests.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

// ---- the page ----

// The panel header's summary on Earn: the user's roles and their counts, in a line.
export function EarnStats({ data }: { data: LiquidityData }) {
  const b = data.builder
  const lp = data.provider
  const roles = [data.access.builder && "Builder", data.access.liquidityProvider && "Liquidity provider"].filter(Boolean) as string[]
  const sum = (k: "committedCents" | "settledCents" | "queuedCents") => (lp ? lp.positions.reduce((n, p) => n + p[k], 0) : 0)
  const stats = [
    ...(lp ? [`${lp.pools.length} open`, `${usd(sum("settledCents"))} settled`, `${usd(sum("queuedCents"))} queued`] : []),
    ...(b ? [`${b.pools.length} of yours`, `${b.pools.filter((p) => stageOf(p) === "awaiting_approval").length} awaiting approval`] : []),
  ]
  return (
    <span className="flex min-w-0 items-center gap-2" data-earn-stats>
      {roles.map((r) => (
        <Badge key={r} variant="secondary" data-role={r}>
          {r}
        </Badge>
      ))}
      <span className="truncate tabular-nums">{stats.join(" · ")}</span>
    </span>
  )
}

// One of Earn's table tabs in the right-hand panel: Opportunities, My positions or My pools.
export function EarnTable({ tab, data, actions, initialForm = null }: { tab: "opportunities" | "my-positions" | "my-pools"; data: LiquidityData; actions: LiquidityActions; initialForm?: OpenForm }) {
  const [form, setForm] = useState<OpenForm>(initialForm)
  const b = data.builder
  const lp = data.provider
  return (
    <div className="h-full overflow-auto p-4" data-tab-panel={tab}>
      {tab === "my-pools" && b && <BuilderPools pools={b.pools} proposable={b.proposable} withdrawalsShown={b.withdrawalsShown} actions={actions} form={form} setForm={setForm} />}
      {tab === "opportunities" && lp && <OpenPools pools={lp.pools} positions={lp.positions} canCommit={lp.canCommit} actions={actions} form={form} setForm={setForm} />}
      {tab === "my-positions" && lp && <MyPositions positions={lp.positions} withdrawals={lp.withdrawals} pools={lp.pools} canWithdraw={lp.canWithdraw} actions={actions} form={form} setForm={setForm} />}
    </div>
  )
}
