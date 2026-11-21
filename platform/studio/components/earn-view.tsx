"use client"

// Earn's table tab (/earn's right-hand panel, beside the assistant: components/earn-assistant.tsx),
// ONE toolbar row (search, the Filters popover, Export CSV, the tab's CTA) and ONE table filling the
// panel, paged as many rows as fit (components/list-layout.tsx PanelList):
// - My pools (builders): their products' pools, each one's state, capital (principal, settled in,
//   settling in, queued for withdrawal, paid out: Not measured, with why, when Mynt couldn't tell),
//   terms, latest verified health and withdrawal queue; "Propose pool" on a sponsored component of
//   their firm's product.
// (Pools, every pool open to the user with "Commit capital", and My strategies are cards, in
// components/earn-assistant.tsx.) Also here: the forms (commit, withdraw, propose), and what a
// liquidity provider holds in a pool (holdingIn), which Pools' cards show, with the card's Details
// sheet (PositionDetailsSheet: amounts, deposits and withdrawal requests, on rails and on chain).
// Each form opens in a sheet from its labelled button. Nothing here moves money: Mynt records a
// request, and the pool's sponsor moves the money on its approved rail. Server-renderable for the tests.
import { useMemo, useState } from "react"
import { OnChainHolding, type OpenDeposit } from "@/components/earn-wallet"
import { newIdempotencyKey } from "@/lib/idempotency"

import type { Facet } from "@/components/filter-controls"
import { downloadCsv } from "@/components/licences-view"
import { MID_COL, PanelList, useFitRows, usePaged, WIDE_COL, WIDEST_COL } from "@/components/list-layout"
import { StatusDot, type DotTone } from "@/components/promotion-view"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { toCsv } from "@/lib/compliance"
import { portfolioOf } from "@/lib/investor"
import { shortAddress } from "@/lib/linked-accounts"
import { usdcText } from "@/lib/wallets"
import {
  CAPITAL_COLUMNS,
  capitalCell,
  commitRefusal,
  filterPools,
  type CapitalCell,
  type CapitalFigure,
  healthText,
  limitsText,
  NO_POOL_FILTERS,
  noticeText,
  parseUsd,
  poolCommitBlock,
  positionKey,
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
  WAITING,
  type LiquidityData,
  type PoolFilters,
  type PoolMoney,
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

// A pool's state as a dot and its words (never a badge: the words are a sentence).
const STAGE_TONE: Record<PoolStage, DotTone> = { cleared: "green", uncleared: "amber", sandbox: "blue", awaiting_approval: "gray" }
export function StageStatus({ stage }: { stage: PoolStage }) {
  return <StatusDot tone={STAGE_TONE[stage]} label={STAGE_LABELS[stage]} title={STAGE_LABELS[stage]} className="max-w-full overflow-hidden font-normal" data-stage={stage} />
}

// Sandbox or real money, as plain text.
export function Money({ sandbox }: { sandbox: boolean }) {
  return (
    <span className="shrink-0 text-xs text-muted-foreground" data-money={sandbox ? "sandbox" : "real"}>
      {sandbox ? "Sandbox" : "Real money"}
    </span>
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

// A pool list's facets for the toolbar's one Filters popover: Product line (where asked for),
// State and Money, each any number of choices.
export function poolFacets(f: PoolFilters, setF: (f: PoolFilters) => void, pools: PoolRow[], stages: PoolStage[], productLines: boolean): Facet[] {
  const lines = [...new Set(pools.map((p) => p.productLine).filter((v): v is string => Boolean(v)))].sort()
  return [
    ...(productLines ? [{ id: "product-line", label: "Product line", options: lines.map((l) => ({ value: l, label: l })), selected: f.productLine, onChange: (productLine: string[]) => setF({ ...f, productLine }) }] : []),
    { id: "state", label: "State", options: stages.map((s) => ({ value: s, label: STAGE_LABELS[s] })), selected: f.stage, onChange: (v) => setF({ ...f, stage: v as PoolStage[] }) },
    { id: "money", label: "Money", options: MONEY_OPTIONS, selected: f.money, onChange: (v) => setF({ ...f, money: v as PoolMoney[] }) },
  ]
}

// What a form in a sheet answered: shown in the sheet in place of the form, until it's closed.
export function FormDone({ message }: { message: string }) {
  return (
    <p role="status" className="text-sm" data-form-done>
      {message}
    </p>
  )
}

// A cell's text on one line: cut short with an ellipsis, the whole of it in its tooltip. A row is
// never taller for long text, so the rows per page that fit the panel stay right. Empty text still
// takes its line, so every row of a table is the same height.
export function OneLine({ text, title, className }: { text: string; title?: string; className?: string }) {
  return (
    <span className={`block max-w-56 truncate ${className ?? ""}`} title={title ?? (text || undefined)}>
      {text || "\u00a0"}
    </span>
  )
}

export function EmptyRow({ cols, children }: { cols: number; children: React.ReactNode }) {
  return (
    <TableRow data-empty-row>
      <TableCell colSpan={cols} className="py-10 text-center !whitespace-normal text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  )
}

export const pagerOf = (paged: { page: number; pages: number; setPage: (p: number) => void }, total: number) => ({ page: paged.page, pages: paged.pages, total, onPage: paged.setPage })

// ---- the builder ----

// The form's fields as given (an assistant's draft proposal prefills them; My pools starts empty).
export type ProposeFields = { option: number; name: string; sandbox: boolean; reservePercent: string; reserveFloor: string; noticeDays: string; minCommit: string; maxCommit: string }

// Every proposal goes with an idempotency key, so sending it again (a double click, a retry after
// a network error) is the pool Mynt already made, never a second one. A key given by the caller (an
// assistant's draft keeps its own with the thread) is used as it is; otherwise the form makes one
// when it opens, and a new one when the terms change or Mynt refuses them.
export function ProposeForm({ options, actions, onDone, initial, idempotencyKey, newKey = newIdempotencyKey }: { options: Sponsored[]; actions: LiquidityActions; onDone: (message: string) => void; initial?: ProposeFields; idempotencyKey?: string; newKey?: () => string }) {
  const [option, setOptionRaw] = useState(initial?.option ?? 0)
  const [name, setNameRaw] = useState(initial?.name ?? "")
  const [sandbox, setSandboxRaw] = useState(initial?.sandbox ?? true)
  const [reservePercent, setReservePercentRaw] = useState(initial?.reservePercent ?? "20")
  const [reserveFloor, setReserveFloorRaw] = useState(initial?.reserveFloor ?? "0")
  const [noticeDays, setNoticeDaysRaw] = useState(initial?.noticeDays ?? "30")
  const [minCommit, setMinCommitRaw] = useState(initial?.minCommit ?? "1000")
  const [maxCommit, setMaxCommitRaw] = useState(initial?.maxCommit ?? "100000")
  const [ownKey, setOwnKey] = useState(newKey)
  const key = idempotencyKey ?? ownKey
  const edit = <T,>(f: (v: T) => void) => (v: T) => {
    f(v)
    if (idempotencyKey === undefined) setOwnKey(newKey())
  }
  const [setOption, setName, setSandbox, setReservePercent, setReserveFloor, setNoticeDays, setMinCommit, setMaxCommit] = [edit(setOptionRaw), edit(setNameRaw), edit(setSandboxRaw), edit(setReservePercentRaw), edit(setReserveFloorRaw), edit(setNoticeDaysRaw), edit(setMinCommitRaw), edit(setMaxCommitRaw)]
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
          void actions.propose({ ...input, idempotency_key: key }).then((r) => {
            setBusy(false)
            if ("error" in r) {
              if (r.refused && idempotencyKey === undefined) setOwnKey(newKey())
              return setError(r.error)
            }
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

// My pools' capital columns: principal from a 32rem panel, the queue from 42rem, the rest from 64rem.
const CAPITAL_COL: Record<CapitalFigure, string> = { principal: MID_COL, queued: WIDE_COL, settledIn: WIDEST_COL, pendingIn: WIDEST_COL, paidOut: WIDEST_COL }
// In Export CSV, a figure Mynt didn't measure says so and why.
const capitalText = (c: CapitalCell) => (c.why && c.text === "Not measured" ? `Not measured (${c.why})` : c.text)

function BuilderPools({ pools, proposable, withdrawalsShown, actions, form, setForm }: { pools: PoolRow[]; proposable: Sponsored[] | null; withdrawalsShown: boolean; actions: LiquidityActions; form: OpenForm; setForm: (f: OpenForm) => void }) {
  const [f, setF] = useState<PoolFilters>(NO_POOL_FILTERS)
  const [done, setDone] = useState<string | null>(null)
  const shown = useMemo(() => filterPools(pools, f), [pools, f])
  const fit = useFitRows()
  const paged = usePaged(shown, fit.size)
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
        ["Pool", "Product", "Component", "State", "Status", "Rails", ...CAPITAL_COLUMNS.map((c) => c.label), "Minimum reserve", "Notice", "Commitment limits", "Latest health", "Withdrawal queue"],
        shown.map((p) => [p.name, p.productName ?? p.productId, p.componentKey, STAGE_LABELS[stageOf(p)], statusText(p), railsApproved(p) ? "Deposit and withdrawal rails approved" : "None yet", ...CAPITAL_COLUMNS.map((c) => capitalText(capitalCell(p, c.key))), reserveText(p), noticeText(p.noticePeriodDays), limitsText(p), healthText(p.health), queue(p)]),
      ),
    )

  return (
    <>
      <PanelList
        id="my-pools"
        search={f.query}
        onSearch={(query) => filter({ ...f, query })}
        searchLabel="Search pools"
        facets={poolFacets(f, filter, pools, ["awaiting_approval", "sandbox", "uncleared", "cleared"], false)}
        onClearFilters={() => filter({ ...NO_POOL_FILTERS, query: f.query })}
        onExport={exportCsv}
        exportDisabled={!shown.length}
        cta={
          // Why it can't be proposed is the button's tooltip, not a line of text above the table.
          <Button
            onClick={() => {
              setDone(null)
              setForm({ kind: "propose" })
            }}
            disabled={Boolean(proposeBlock)}
            title={proposeBlock ?? undefined}
            data-cta="propose"
          >
            Propose pool
          </Button>
        }
        areaRef={fit.ref}
        {...pagerOf(paged, shown.length)}
      >
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Pool</TableHead>
              <TableHead className={MID_COL}>State</TableHead>
              <TableHead className={WIDE_COL}>Status</TableHead>
              <TableHead className={WIDE_COL}>Rails</TableHead>
              {CAPITAL_COLUMNS.map((c) => (
                <TableHead key={c.key} className={`${CAPITAL_COL[c.key]} text-right`}>
                  {c.label}
                </TableHead>
              ))}
              <TableHead className={WIDE_COL}>Minimum reserve</TableHead>
              <TableHead className={WIDE_COL}>Notice</TableHead>
              <TableHead className={WIDE_COL}>Commitment limits</TableHead>
              <TableHead className={WIDE_COL}>Latest health</TableHead>
              <TableHead className="text-right">Withdrawal queue</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.shown.length ? (
              paged.shown.map((p) => (
                <TableRow key={p.id} data-pool={p.id}>
                  <TableCell>
                    <OneLine className="font-medium" text={p.name} />
                    <OneLine className="text-xs text-muted-foreground" text={`${p.productName ?? p.productId}${p.componentKey ? ` · ${p.componentKey}` : ""}`} />
                  </TableCell>
                  <TableCell className={MID_COL}>
                    <StageStatus stage={stageOf(p)} />
                  </TableCell>
                  <TableCell className={WIDE_COL}>
                    <OneLine text={statusText(p)} />
                  </TableCell>
                  <TableCell className={WIDE_COL}>{railsApproved(p) ? "Deposit and withdrawal rails approved" : "None yet"}</TableCell>
                  {CAPITAL_COLUMNS.map((c) => {
                    const cell = capitalCell(p, c.key)
                    return (
                      <TableCell key={c.key} className={`${CAPITAL_COL[c.key]} text-right tabular-nums`} data-capital={c.key} title={cell.why ?? undefined}>
                        <OneLine text={cell.text} />
                      </TableCell>
                    )
                  })}
                  <TableCell className={WIDE_COL}>
                    <OneLine text={reserveText(p)} />
                  </TableCell>
                  <TableCell className={WIDE_COL}>{noticeText(p.noticePeriodDays)}</TableCell>
                  <TableCell className={`${WIDE_COL} tabular-nums`}>{limitsText(p)}</TableCell>
                  <TableCell className={WIDE_COL} data-health>
                    <OneLine text={healthText(p.health)} />
                    <OneLine className="text-xs text-muted-foreground" text={p.health?.latestVerifiedEnd && !p.health.verified ? `Last verified to ${dateOf(p.health.latestVerifiedEnd)}` : ""} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums" data-queue>
                    {queue(p)}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <EmptyRow cols={9 + CAPITAL_COLUMNS.length}>{pools.length ? "No pools match these filters." : "No pools yet. Propose one on a sponsored component of your product."}</EmptyRow>
            )}
          </TableBody>
        </Table>
      </PanelList>
      <FormSheet open={form?.kind === "propose" && Boolean(proposable?.length)} onClose={() => setForm(null)} title="Propose a pool" id="propose">
        {done ? <FormDone message={done} /> : proposable?.length ? <ProposeForm options={proposable} actions={actions} onDone={setDone} /> : null}
      </FormSheet>
    </>
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

// A figure Mynt doesn't give reads Not measured, never 0.
const money = (cents: number | null) => (cents === null ? "Not measured" : usd(cents))
const stateOf = (p: Position) => (p.state ? p.state.slice(3).toUpperCase() : null)

// One position's amounts: a rails row as Mynt sends it; an on-chain row from its deposits and
// requests (lib/investor.ts), where an amount Mynt didn't give is null.
export function positionFigures(p: Position): { committed: number | null; settled: number | null; queued: number | null; paid: number | null; available: number | null } {
  if (!p.onChain) return { committed: p.committedCents, settled: p.settledCents, queued: p.queuedCents, paid: p.paidCents, available: p.availableCents }
  const t = portfolioOf([p]).all
  return { ...t, available: Number.isFinite(p.availableCents) ? p.availableCents : null }
}

// A withdrawal request as a row of a pool's Details: rails requests in dollars, on-chain ones in USDC.
type RequestRow = { key: string; pool: string; sandbox: boolean; onChain: boolean; wallet: string | null; place: string; asked: string; paid: string; status: string; payableFrom: string; why: string | null }
export function requestRows(withdrawals: Withdrawal[], positions: Position[]): RequestRow[] {
  const rails = withdrawals.map((w) => ({ key: w.id, pool: w.poolName ?? w.poolId, sandbox: w.sandbox, onChain: false, wallet: null, place: w.seq !== null ? `#${w.seq}` : "—", asked: usd(w.amountCents), paid: usd(w.settledCents), status: w.status.replace(/_/g, " "), payableFrom: dateOf(w.eligibleAt), why: w.waitingReason }))
  const chain = positions.flatMap((p) =>
    p.onChain && p.chain
      ? p.chain.requests.map((r) => ({ key: r.address, pool: p.name, sandbox: p.sandbox, onChain: true, wallet: p.chain!.wallet, place: r.seq !== null ? `#${r.seq}` : shortAddress(r.address), asked: usdcText(r.amount), paid: usdcText(r.paid), status: r.status.replace(/_/g, " "), payableFrom: r.payableAt ? r.payableAt.slice(0, 10) : "—", why: null }))
      : [],
  )
  return [...rails, ...chain]
}

// ---- a liquidity provider's position in a pool (on its card in Pools) ----

// On-chain requests that no longer wait.
const ENDED = new Set(["paid", "settled", "cancelled", "canceled", "closed", "rejected"])

// What a liquidity provider holds in one pool, over its positions there (one on rails, one per
// wallet on chain): the summed figures (null when any of them isn't measured), and the withdrawal
// requests still waiting, counted by status (queued, parked, paying; on chain, those not yet paid).
export type Holding = {
  positions: Position[]
  rails: Position | null
  chain: Position[]
  figures: { settled: number | null; queued: number | null; paid: number | null; available: number | null }
  waiting: { status: string; count: number }[]
}
export function holdingIn(poolId: string, positions: Position[], withdrawals: Withdrawal[]): Holding | null {
  const mine = positions.filter((p) => p.poolId === poolId && (!p.onChain || Boolean(p.chain)))
  if (!mine.length) return null
  const figs = mine.map(positionFigures)
  const total = (k: "settled" | "queued" | "paid" | "available") => (figs.some((f) => f[k] === null) ? null : figs.reduce((n, f) => n + (f[k] as number), 0))
  const statuses = [
    ...withdrawals.filter((w) => w.poolId === poolId && WAITING.has(w.status)).map((w) => w.status),
    ...mine.flatMap((p) => (p.chain ? p.chain.requests.filter((r) => r.remaining > 0n && !ENDED.has(r.status)).map((r) => r.status) : [])),
  ]
  const waiting = [...new Set(statuses)].map((status) => ({ status: status.replace(/_/g, " "), count: statuses.filter((s) => s === status).length }))
  return { positions: mine, rails: mine.find((p) => !p.onChain) ?? null, chain: mine.filter((p) => p.onChain), figures: { settled: total("settled"), queued: total("queued"), paid: total("paid"), available: total("available") }, waiting }
}
// "$4,000.00", its queue and what's been paid, as a card's line says them.
export const holdingFigures = (h: Holding) => ({ held: money(h.figures.settled), queued: money(h.figures.queued), paid: money(h.figures.paid), available: money(h.figures.available) })
// "2 withdrawal requests: 1 queued, 1 parked", or "" with none waiting.
export function waitingText(h: Holding | null): string {
  if (!h?.waiting.length) return ""
  const n = h.waiting.reduce((s, w) => s + w.count, 0)
  return `${n} withdrawal ${n === 1 ? "request" : "requests"}: ${h.waiting.map((w) => `${w.count} ${w.status}`).join(", ")}`
}

// A rails position's amounts, laid out like the dashboard's key figures.
function RailsFigures({ p }: { p: Position }) {
  const f = positionFigures(p)
  const figures: [string, string, string][] = [
    ["committed", "Committed", money(f.committed)],
    ["settled", "Settled", money(f.settled)],
    ["queued", "Queued", money(f.queued)],
    ["paid", "Paid", money(f.paid)],
    ["available", "Available", money(f.available)],
    ["state", "US state", stateOf(p) ?? "—"],
  ]
  return (
    <dl className="grid grid-cols-3 gap-y-3" data-rails-figures>
      {figures.map(([key, label, value]) => (
        <div key={key} className="flex min-w-0 flex-col gap-1 pr-4" data-figure={key}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="text-lg font-semibold tabular-nums" {...{ [`data-${key}`]: "true" }}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function RequestsTable({ rows }: { rows: RequestRow[] }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">No withdrawal requests.</p>
  return (
    <div className="overflow-auto rounded-lg border" data-rails-requests>
      <Table>
        <TableHeader className="bg-card">
          <TableRow>
            <TableHead>Place in queue</TableHead>
            <TableHead className="text-right">Asked</TableHead>
            <TableHead className="text-right">Paid</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Payable from</TableHead>
            <TableHead>Why it&apos;s waiting</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.key} data-withdrawal={r.key}>
              <TableCell className="tabular-nums">{r.place}</TableCell>
              <TableCell className="text-right tabular-nums" data-asked>
                {r.asked}
              </TableCell>
              <TableCell className="text-right tabular-nums" data-paid>
                {r.paid}
              </TableCell>
              <TableCell className="capitalize" data-status>
                {r.status}
              </TableCell>
              <TableCell>{r.payableFrom}</TableCell>
              <TableCell className="text-muted-foreground">
                <OneLine text={r.why ?? "—"} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

// A pool card's Details: what the user holds in the pool, on rails (its amounts and the firm's
// withdrawal requests there) and per wallet on chain (its deposits, each with Withdraw, and its
// requests). Withdraw on a deposit turns the sheet into that deposit's withdrawal.
export function PositionDetailsSheet({ name, holding, withdrawals, pools, onClose }: { name: string; holding: Holding | null; withdrawals: Withdrawal[]; pools: PoolRow[]; onClose: () => void }) {
  const [open, setOpen] = useState<OpenDeposit | null>(null)
  const close = () => {
    setOpen(null)
    onClose()
  }
  const rails = holding?.rails ?? null
  const railsRequests = rails ? requestRows(withdrawals.filter((w) => w.poolId === rails.poolId), []) : []
  const opened = open ? (holding?.chain.find((p) => p.chain?.wallet === open.wallet) ?? null) : null
  return (
    <Sheet open={Boolean(holding)} onOpenChange={(o) => !o && close()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl" aria-describedby={undefined} data-sheet={open ? "on-chain-withdraw" : "position-details"}>
        <SheetHeader>
          <SheetTitle>{open ? `Withdraw from ${open.poolName}` : name}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-5 px-4 pb-4">
          {open && opened ? (
            <OnChainHolding position={opened} pools={pools} open={open} onOpen={setOpen} />
          ) : holding ? (
            <>
              {rails && (
                <section className="flex flex-col gap-3" data-rails-position={rails.poolId}>
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    On rails
                    <Money sandbox={rails.sandbox} />
                  </h3>
                  <RailsFigures p={rails} />
                  <RequestsTable rows={railsRequests} />
                </section>
              )}
              {holding.chain.map((p) => (
                <section key={positionKey(p)} className="flex flex-col gap-3" data-chain-position={positionKey(p)}>
                  <h3 className="text-sm font-semibold">On chain</h3>
                  <OnChainHolding position={p} pools={pools} open={null} onOpen={setOpen} />
                </section>
              ))}
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ---- the page ----

// Earn's table tab in the right-hand panel: My pools, one toolbar row and one table filling the
// panel (components/list-layout.tsx PanelList).
export function EarnTable({ tab, data, actions, initialForm = null }: { tab: "my-pools"; data: LiquidityData; actions: LiquidityActions; initialForm?: OpenForm }) {
  const [form, setForm] = useState<OpenForm>(initialForm)
  const b = data.builder
  if (tab === "my-pools" && b) return <BuilderPools pools={b.pools} proposable={b.proposable} withdrawalsShown={b.withdrawalsShown} actions={actions} form={form} setForm={setForm} />
  return <div className="h-full" data-tab-panel={tab} />
}
