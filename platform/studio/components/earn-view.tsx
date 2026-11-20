"use client"

// Earn's table tabs (/earn's right-hand panel, beside the assistant: components/earn-assistant.tsx),
// by role, each in the dashboard's list layout: one toolbar row (search, filters, Export CSV, the
// tab's CTA), then a full-height table paged 25 rows at a time:
// - My pools (builders): their products' pools, each one's state, terms, latest verified
//   health and withdrawal queue; "Propose pool" on a sponsored component of their firm's product.
// - Opportunities (liquidity providers): pools open to commitments, their health and terms, and
//   "Commit capital".
// - My positions (liquidity providers): key figures, then committed, settled, queued and paid per
//   position, "Request withdrawal", on-chain positions, and the firm's requests in each pool's queue.
// Each form opens in a sheet from its labelled button. Nothing here moves money: Mynt records a
// request, and the pool's sponsor moves the money on its approved rail. Server-renderable for the tests.
import { useMemo, useState } from "react"
import { OnChainPositions } from "@/components/earn-wallet"
import { newIdempotencyKey } from "@/lib/idempotency"
import { Download } from "lucide-react"

import { KpiRow } from "@/components/charts"
import { Panel, Section } from "@/components/dashboard-panels"
import { FilterSelect } from "@/components/filter-controls"
import { downloadCsv } from "@/components/licences-view"
import { ListLayout, usePaged } from "@/components/list-layout"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { toCsv } from "@/lib/compliance"
import type { Kpi } from "@/lib/dashboard-visual"
import { portfolioOf, positionExtras } from "@/lib/investor"
import {
  commitRefusal,
  filterPools,
  healthText,
  limitsText,
  NO_POOL_FILTERS,
  noticeText,
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

export type ActionResult = { ok: true; reply: unknown } | { error: string; refused?: boolean }
export type LiquidityActions = {
  propose(input: ProposeInput): Promise<ActionResult>
  commit(input: { pool_id: string; amount_cents: number; state: string; idempotency_key: string }): Promise<ActionResult>
  withdraw(input: { pool_id: string; amount_cents: number; idempotency_key: string }): Promise<ActionResult>
}
export type OpenForm = { kind: "propose" } | { kind: "commit"; poolId?: string } | { kind: "withdraw"; poolId?: string } | null

const selectClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
export { newIdempotencyKey }
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

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  )
}

// The form a CTA opens: a sheet on the right with the form's title; the form itself says, in one
// line, what the action does with money.
export function FormSheet({ open, onClose, title, id, children }: { open: boolean; onClose: () => void; title: string; id: string; children: React.ReactNode }) {
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" aria-describedby={undefined} data-sheet={id}>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <div className="px-4 pb-4">{children}</div>
      </SheetContent>
    </Sheet>
  )
}

const MONEY_OPTIONS = [
  { value: "sandbox", label: "Sandbox" },
  { value: "real", label: "Real money" },
]

// A pool table's filters, as buttons in the toolbar row after the search.
function PoolFilterControls({ f, setF, pools, stages, productLines }: { f: PoolFilters; setF: (f: PoolFilters) => void; pools: PoolRow[]; stages: PoolStage[]; productLines: boolean }) {
  const lines = [...new Set(pools.map((p) => p.productLine).filter((v): v is string => Boolean(v)))].sort()
  return (
    <>
      {productLines && <FilterSelect label="Product line" value={f.productLine} onChange={(productLine) => setF({ ...f, productLine })} options={lines.map((l) => ({ value: l, label: l }))} />}
      <FilterSelect label="State" value={f.stage} onChange={(v) => setF({ ...f, stage: v as PoolFilters["stage"] })} options={stages.map((s) => ({ value: s, label: STAGE_LABELS[s] }))} />
      <FilterSelect label="Money" value={f.money} onChange={(v) => setF({ ...f, money: v as PoolFilters["money"] })} options={MONEY_OPTIONS} />
    </>
  )
}

function ExportButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <Button variant="outline" onClick={onClick} disabled={disabled} data-export>
      <Download />
      Export CSV
    </Button>
  )
}

function EmptyRow({ cols, children }: { cols: number; children: React.ReactNode }) {
  return (
    <TableRow>
      <TableCell colSpan={cols} className="py-10 text-center text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  )
}

const pagerOf = (paged: { page: number; pages: number; setPage: (p: number) => void }, total: number) => ({ page: paged.page, pages: paged.pages, total, onPage: paged.setPage })

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
    <div className="flex flex-col gap-4" data-form="propose">
      <p className="text-sm text-muted-foreground" data-consequence>
        The pool starts paused: {sponsor} must approve it and name the money rails before it takes any commitment, and real-money commitments also wait for a Mynt admin to clear it.
      </p>
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
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          Notice period (days)
          <Input value={noticeDays} onChange={(e) => setNoticeDays(e.target.value)} inputMode="numeric" aria-label="Notice period days" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Smallest position per firm (USD)
          <Input value={minCommit} onChange={(e) => setMinCommit(e.target.value)} inputMode="decimal" aria-label="Smallest position" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Largest position per firm (USD)
          <Input value={maxCommit} onChange={(e) => setMaxCommit(e.target.value)} inputMode="decimal" aria-label="Largest position" />
        </label>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          <Button type="submit" disabled={busy || "error" in input}>
            Propose pool
          </Button>
          {"error" in input ? <span className="text-sm text-muted-foreground">{input.error}</span> : null}
        </div>
        {error && <Alert>{error}</Alert>}
      </form>
    </div>
  )
}

function BuilderPools({ pools, proposable, withdrawalsShown, actions, form, setForm }: { pools: PoolRow[]; proposable: Sponsored[] | null; withdrawalsShown: boolean; actions: LiquidityActions; form: OpenForm; setForm: (f: OpenForm) => void }) {
  const [f, setF] = useState<PoolFilters>(NO_POOL_FILTERS)
  const [done, setDone] = useState<string | null>(null)
  const shown = useMemo(() => filterPools(pools, f), [pools, f])
  const paged = usePaged(shown)
  const filter = (n: PoolFilters) => {
    setF(n)
    paged.setPage(1)
  }
  const proposeBlock = proposable === null ? "Proposing pools comes with Mynt's next update." : proposable.length ? null : "A licence provider must sponsor a component of one of your products before it can have a pool."
  const queue = (p: PoolRow) => (withdrawalsShown && p.queueLength !== null ? String(p.queueLength) : "Not available yet")
  const exportCsv = () =>
    downloadCsv(
      "my-pools.csv",
      toCsv(
        ["Pool", "Product", "Component", "State", "Status", "Rails", "Minimum reserve", "Notice", "Commitment limits", "Latest health", "Withdrawal queue"],
        shown.map((p) => [p.name, p.productName ?? p.productId, p.componentKey, STAGE_LABELS[stageOf(p)], statusText(p), railsApproved(p) ? "Deposit and withdrawal rails approved" : "None yet", reserveText(p), noticeText(p.noticePeriodDays), limitsText(p), healthText(p.health), queue(p)]),
      ),
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-tab-panel="my-pools">
      {proposeBlock && (
        <p className="text-sm text-muted-foreground" data-sponsor-note>
          {proposeBlock}
        </p>
      )}
      {done && (
        <p className="text-sm" role="status">
          {done}
        </p>
      )}
      <ListLayout
        search={f.query}
        onSearch={(query) => filter({ ...f, query })}
        searchLabel="Search pools"
        actions={
          <>
            <PoolFilterControls f={f} setF={filter} pools={pools} stages={["awaiting_approval", "sandbox", "uncleared", "cleared"]} productLines={false} />
            <ExportButton onClick={exportCsv} disabled={!shown.length} />
          </>
        }
        cta={
          <Button onClick={() => setForm({ kind: "propose" })} disabled={Boolean(proposeBlock)} title={proposeBlock ?? undefined} data-cta="propose">
            Propose pool
          </Button>
        }
        {...pagerOf(paged, shown.length)}
      >
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Pool</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Rails</TableHead>
              <TableHead>Minimum reserve</TableHead>
              <TableHead>Notice</TableHead>
              <TableHead>Commitment limits</TableHead>
              <TableHead>Latest health</TableHead>
              <TableHead className="text-right">Withdrawal queue</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.shown.length ? (
              paged.shown.map((p) => (
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
                  <TableCell className="whitespace-normal" data-health>
                    {healthText(p.health)}
                    {p.health?.latestVerifiedEnd && !p.health.verified ? <div className="text-xs text-muted-foreground">Last verified to {dateOf(p.health.latestVerifiedEnd)}</div> : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums" data-queue>
                    {queue(p)}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <EmptyRow cols={9}>{pools.length ? "No pools match these filters." : "No pools yet. Propose one on a sponsored component of your product."}</EmptyRow>
            )}
          </TableBody>
        </Table>
      </ListLayout>
      <FormSheet open={form?.kind === "propose" && Boolean(proposable?.length)} onClose={() => setForm(null)} title="Propose a pool" id="propose">
        {proposable?.length ? (
          <ProposeForm
            options={proposable}
            actions={actions}
            onDone={(m) => {
              setDone(m)
              setForm(null)
            }}
          />
        ) : null}
      </FormSheet>
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
    <div className="flex flex-col gap-4" data-form="commit">
      <p className="text-sm text-muted-foreground" data-consequence>
        This asks for a deposit on the pool&apos;s approved rail. Mynt never holds your funds: the pool&apos;s sponsor moves the money, and your position counts only what has settled.
      </p>
      <form
        className="grid gap-3 sm:grid-cols-2"
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
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
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
        {pool && (
          <p className="text-sm text-muted-foreground sm:col-span-2" data-terms>
            {limitsText(pool)}; notice period {noticeText(pool.noticePeriodDays).toLowerCase()}; minimum reserve {reserveText(pool)}.
            {position ? ` Your position now: ${usd(position.settledCents)} settled, ${usd(position.pendingInCents)} on its way in.` : ""}
            {lockedState ? " Your state is fixed while you hold a position here." : ""}
          </p>
        )}
        {refusal && amount !== "" ? (
          <p className="text-sm text-amber-600 sm:col-span-2 dark:text-amber-300" data-refusal>
            {refusal}
          </p>
        ) : refusal && pool && poolCommitBlock(pool, position) ? (
          <p className="text-sm text-amber-600 sm:col-span-2 dark:text-amber-300" data-refusal>
            {refusal}
          </p>
        ) : null}
        <div className="sm:col-span-2">
          <Button type="submit" disabled={busy || Boolean(refusal) || !chosenState} data-submit="commit">
            Commit capital
          </Button>
        </div>
        {error && <Alert>{error}</Alert>}
      </form>
    </div>
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
    <div className="flex flex-col gap-4" data-form="withdraw">
      <p className="text-sm text-muted-foreground" data-consequence data-withdraw-terms>
        {withdrawalTerms(pool?.noticePeriodDays ?? null)}
      </p>
      <form
        className="grid gap-3 sm:grid-cols-2"
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
        {refusal && (amount !== "" || !position || position.availableCents <= 0) ? (
          <p className="text-sm text-amber-600 sm:col-span-2 dark:text-amber-300" data-refusal>
            {refusal}
          </p>
        ) : null}
        <div className="sm:col-span-2">
          <Button type="submit" disabled={busy || Boolean(refusal)} data-submit="withdraw">
            Request withdrawal
          </Button>
        </div>
        {error && <Alert>{error}</Alert>}
      </form>
    </div>
  )
}

function OpenPools({ pools, positions, canCommit, actions, form, setForm }: { pools: PoolRow[]; positions: Position[]; canCommit: boolean; actions: LiquidityActions; form: OpenForm; setForm: (f: OpenForm) => void }) {
  const [f, setF] = useState<PoolFilters>(NO_POOL_FILTERS)
  const [done, setDone] = useState<string | null>(null)
  const shown = useMemo(() => filterPools(pools, f), [pools, f])
  const paged = usePaged(shown)
  const filter = (n: PoolFilters) => {
    setF(n)
    paged.setPage(1)
  }
  const position = (id: string) => positions.find((p) => p.poolId === id)
  const anyOpen = pools.some((p) => !poolCommitBlock(p, position(p.id)))
  const exportCsv = () =>
    downloadCsv(
      "opportunities.csv",
      toCsv(
        ["Pool", "Product", "Product line", "State", "Status", "Health", "Minimum reserve", "Notice", "Commitment limits"],
        shown.map((p) => [p.name, p.productName ?? p.productId, p.productLine, STAGE_LABELS[stageOf(p)], statusText(p), healthText(p.health), reserveText(p), noticeText(p.noticePeriodDays), limitsText(p)]),
      ),
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-tab-panel="opportunities">
      {done && (
        <p className="text-sm" role="status">
          {done}
        </p>
      )}
      <ListLayout
        search={f.query}
        onSearch={(query) => filter({ ...f, query })}
        searchLabel="Search open pools"
        actions={
          <>
            <PoolFilterControls f={f} setF={filter} pools={pools} stages={["sandbox", "cleared", "uncleared"]} productLines />
            <ExportButton onClick={exportCsv} disabled={!shown.length} />
          </>
        }
        cta={
          <Button onClick={() => setForm({ kind: "commit" })} disabled={!canCommit || !anyOpen} title={!canCommit ? "Committing capital comes with Mynt's next update" : !anyOpen ? "No pool is taking commitments right now" : undefined} data-cta="commit">
            Commit capital
          </Button>
        }
        {...pagerOf(paged, shown.length)}
      >
        <Table>
          <TableHeader className="sticky top-0 bg-card">
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
            {paged.shown.length ? (
              paged.shown.map((p) => {
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
              <EmptyRow cols={9}>{pools.length ? "No pools match these filters." : "No pools are open to commitments yet."}</EmptyRow>
            )}
          </TableBody>
        </Table>
      </ListLayout>
      <FormSheet open={form?.kind === "commit" && pools.length > 0} onClose={() => setForm(null)} title="Commit capital" id="commit">
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
      </FormSheet>
    </div>
  )
}

// My positions' key figures, from all the positions (on rails and on chain, summed as the investor
// dashboard sums them). A figure Mynt doesn't give reads Not measured, never 0.
export function positionKpis(positions: Position[]): Kpi[] {
  const p = portfolioOf(positions)
  const extra = positionExtras(positions)
  const test = positions.some((x) => x.sandbox || x.onChain)
  const note = `${positions.length} ${positions.length === 1 ? "position" : "positions"}${test ? " · includes test money" : ""}`
  return [
    { key: "committed", label: "Committed", value: p.all.committed, unit: "money", delta: null, spark: null, note },
    { key: "settled", label: "Settled", value: p.all.settled, unit: "money", delta: null, spark: null, note },
    { key: "available", label: "Available to withdraw", value: extra.available, unit: "money", delta: null, spark: null, note },
    { key: "queued", label: "Queued for withdrawal", value: p.all.queued, unit: "money", delta: null, spark: null, note },
  ]
}

function MyPositions({ positions: all, withdrawals, pools, canWithdraw, actions, form, setForm }: { positions: Position[]; withdrawals: Withdrawal[]; pools: PoolRow[]; canWithdraw: boolean; actions: LiquidityActions; form: OpenForm; setForm: (f: OpenForm) => void }) {
  // Positions on rails in the table; on-chain ones (devnet, per wallet and deposit) below it.
  const positions = useMemo(() => all.filter((p) => !p.onChain), [all])
  const onChain = all.filter((p) => p.onChain && p.chain)
  const [query, setQuery] = useState("")
  const [money, setMoney] = useState("")
  const [done, setDone] = useState<string | null>(null)
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return positions.filter((p) => (!q || p.name.toLowerCase().includes(q) || p.productId.toLowerCase().includes(q)) && (!money || (money === "sandbox") === p.sandbox))
  }, [positions, query, money])
  const paged = usePaged(shown)
  const anyAvailable = positions.some((p) => p.availableCents > 0)
  const exportCsv = () =>
    downloadCsv(
      "my-positions.csv",
      toCsv(
        ["Pool", "Product", "US state", "Money", "Committed", "Settled", "Queued", "Paid", "Available"],
        shown.map((p) => [p.name, p.productId, p.state ? p.state.slice(3).toUpperCase() : null, p.sandbox ? "Sandbox" : "Real money", usd(p.committedCents), usd(p.settledCents), usd(p.queuedCents), usd(p.paidCents), usd(p.availableCents)]),
      ),
    )

  return (
    <div className="flex flex-col gap-4" data-tab-panel="my-positions">
      <Panel id="position-figures">
        <KpiRow kpis={positionKpis(all)} />
      </Panel>
      {done && (
        <p className="text-sm" role="status">
          {done}
        </p>
      )}
      <ListLayout
        search={query}
        onSearch={(v) => {
          setQuery(v)
          paged.setPage(1)
        }}
        searchLabel="Search positions"
        actions={
          <>
            <FilterSelect
              label="Money"
              value={money}
              onChange={(v) => {
                setMoney(v)
                paged.setPage(1)
              }}
              options={MONEY_OPTIONS}
            />
            <ExportButton onClick={exportCsv} disabled={!shown.length} />
          </>
        }
        cta={
          <Button onClick={() => setForm({ kind: "withdraw" })} disabled={!canWithdraw || !anyAvailable} title={!canWithdraw ? "Withdrawals come with Mynt's next update" : !anyAvailable ? "Nothing settled is available to withdraw" : undefined} data-cta="withdraw">
            Request withdrawal
          </Button>
        }
        {...pagerOf(paged, shown.length)}
      >
        <Table>
          <TableHeader className="sticky top-0 bg-card">
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
            {paged.shown.length ? (
              paged.shown.map((p) => (
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
              <EmptyRow cols={8}>{positions.length ? "No positions match this search." : onChain.length ? "No positions on rails." : "No positions yet. Commit capital to an open pool to start one."}</EmptyRow>
            )}
          </TableBody>
        </Table>
      </ListLayout>
      <OnChainPositions positions={onChain} pools={pools} />
      <Panel id="withdrawal-requests">
        <Section id="withdrawal-requests" title="Your withdrawal requests">
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
                  <EmptyRow cols={7}>No withdrawal requests.</EmptyRow>
                )}
              </TableBody>
            </Table>
          </div>
        </Section>
      </Panel>
      <FormSheet open={form?.kind === "withdraw" && positions.length > 0} onClose={() => setForm(null)} title="Request withdrawal" id="withdraw">
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
      </FormSheet>
    </div>
  )
}

// ---- the page ----

// One of Earn's table tabs in the right-hand panel: Opportunities, My positions or My pools. The
// pool tables fill the panel; My positions scrolls as a page (figures, table, then its sections).
export function EarnTable({ tab, data, actions, initialForm = null }: { tab: "opportunities" | "my-positions" | "my-pools"; data: LiquidityData; actions: LiquidityActions; initialForm?: OpenForm }) {
  const [form, setForm] = useState<OpenForm>(initialForm)
  const b = data.builder
  const lp = data.provider
  return (
    <div className={tab === "my-positions" ? "h-full overflow-y-auto p-4" : "flex h-full min-h-0 flex-col p-4"} data-tab-panel={tab}>
      {tab === "my-pools" && b && <BuilderPools pools={b.pools} proposable={b.proposable} withdrawalsShown={b.withdrawalsShown} actions={actions} form={form} setForm={setForm} />}
      {tab === "opportunities" && lp && <OpenPools pools={lp.pools} positions={lp.positions} canCommit={lp.canCommit} actions={actions} form={form} setForm={setForm} />}
      {tab === "my-positions" && lp && <MyPositions positions={lp.positions} withdrawals={lp.withdrawals} pools={lp.pools} canWithdraw={lp.canWithdraw} actions={actions} form={form} setForm={setForm} />}
    </div>
  )
}
