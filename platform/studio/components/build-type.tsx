"use client"

// The Build page's Type: what's being built is one of three things, an app, a financial product or a service, picked
// from one labelled dropdown in the composer ("Type: App"), each choice with a line saying what it is. And what
// Service adds to the page: the service type and region picker (Mynt's admin-defined service types, each with its
// licence prerequisite), its two tabs (Service types; Requested service types) and the Request a service type sheet
// (request_service_type: a name, what it does, one example input and one example output, each a JSON object).
// Server-renderable for the tests.
import { useEffect, useMemo, useState } from "react"
import { AppWindow, Check, ChevronDown, Landmark, Plus, Search, ServerCog, type LucideIcon } from "lucide-react"

import { AdminSheet, AdminTable, Field, fieldClass, useAdminAction } from "@/components/admin-kit"
import { matches, TOOLBAR_ROW, TOOLBAR_SEARCH } from "@/components/list-layout"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { categoryLabel } from "@/lib/marketplace"
import {
  BUILD_TYPE_DESCRIPTIONS,
  BUILD_TYPE_LABELS,
  BUILD_TYPES,
  isBuildType,
  jsonObjectOf,
  licencePrerequisite,
  typeChoiceId,
  type BuildType,
  type ServiceTypeChoice,
  type ServiceTypeRequest,
} from "@/lib/services"
import { cn } from "@/lib/utils"

export const BUILD_TYPE_ICONS: Record<BuildType, LucideIcon> = { app: AppWindow, product: Landmark, service: ServerCog }

// ---- the composer's Type dropdown ----

/** "Type: App ▾": a labelled button opening the three choices as a radio group, each with what it is. */
export function TypeMenu({ type, onType }: { type: BuildType; onType: (t: BuildType) => void }) {
  const Current = BUILD_TYPE_ICONS[type]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="sm" variant="outline" className="h-8 shrink-0 gap-1.5" aria-label={`Type: ${BUILD_TYPE_LABELS[type]}`} data-type-trigger data-type={type}>
          <Current aria-hidden />
          <span className="text-xs" data-type-label>
            Type: {BUILD_TYPE_LABELS[type]}
          </span>
          <ChevronDown className="size-3.5 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80" data-type-menu>
        <DropdownMenuRadioGroup value={type} onValueChange={(v) => isBuildType(v) && v !== type && onType(v)} aria-label="What to build">
          {BUILD_TYPES.map((t) => {
            const Icon = BUILD_TYPE_ICONS[t]
            return (
              <DropdownMenuRadioItem key={t} value={t} className="items-start" data-type-option={t}>
                <Icon className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium" data-type-option-label>
                    {BUILD_TYPE_LABELS[t]}
                  </span>
                  <span className="text-xs whitespace-normal text-muted-foreground" data-type-option-description>
                    {BUILD_TYPE_DESCRIPTIONS[t]}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---- Service: the service type and region picker ----

export function serviceTypeLabel(picked: string | null, types: readonly ServiceTypeChoice[] | null): string {
  if (!picked) return "Pick a service type"
  const t = types?.find((x) => typeChoiceId(x) === picked)
  return t ? `${t.name} · ${t.region}` : picked
}

export function ServiceTypePicker({
  types,
  picked,
  onPick,
  onRequest,
}: {
  types: ServiceTypeChoice[] | null
  picked: string | null
  onPick: (id: string) => void
  onRequest?: () => void
}) {
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const shown = (types ?? []).filter((t) => matches(query, t.name, t.key, t.region, categoryLabel(t.category), t.description))
  const regions = [...new Set(shown.map((t) => t.region))].sort()
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="ghost" className="h-8 max-w-64 gap-1.5" aria-label={`Service type: ${serviceTypeLabel(picked, types)}`} data-service-type-picker>
          <ServerCog />
          <span className="truncate text-xs" data-service-type-label>
            {serviceTypeLabel(picked, types)}
          </span>
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-96 flex-col gap-2 p-2" data-service-type-menu>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search service types" aria-label="Search service types to pick" className="h-8" />
        <div className="max-h-72 overflow-y-auto" role="radiogroup" aria-label="Service types">
          {types === null ? (
            <Skeleton className="m-2 h-4" data-loading />
          ) : !shown.length ? (
            <p className="p-2 text-sm text-muted-foreground">{types.length ? "No service types match." : "Mynt has no service types yet. Request one."}</p>
          ) : (
            regions.map((region) => (
              <div key={region} data-picker-region={region}>
                <p className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">Region: {region}</p>
                {shown
                  .filter((t) => t.region === region)
                  .map((t) => {
                    const id = typeChoiceId(t)
                    const on = id === picked
                    return (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => {
                          onPick(id)
                          setOpen(false)
                        }}
                        className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                        data-service-type-option={id}
                      >
                        <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", on && "border-primary bg-primary text-primary-foreground")}>{on && <Check className="size-3" />}</span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate">{t.name}</span>
                          <span className="text-xs text-muted-foreground" data-licence-prerequisite>
                            {licencePrerequisite(t)}
                          </span>
                        </span>
                      </button>
                    )
                  })}
              </div>
            ))
          )}
        </div>
        {onRequest && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 justify-start border-t"
            onClick={() => {
              setOpen(false)
              onRequest()
            }}
            data-picker-request-type
          >
            <Plus />
            Request a service type
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ---- Service's tabs ----

function PanelTable({ id, query, onQuery, searchLabel, cta, children }: { id: string; query: string; onQuery: (q: string) => void; searchLabel: string; cta?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3" data-panel-list={id}>
      <div className={TOOLBAR_ROW} data-toolbar>
        <div className={TOOLBAR_SEARCH}>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => onQuery(e.target.value)} placeholder={searchLabel} aria-label={searchLabel} className="pl-8" />
        </div>
        {cta}
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border" data-table-view>
        {children}
      </div>
    </div>
  )
}

function RequestButton({ onRequest }: { onRequest: () => void }) {
  return (
    <Button onClick={onRequest} data-request-service-type>
      <Plus />
      Request a service type
    </Button>
  )
}

/** Mynt's service types: what a service can be, each with its region and its licence prerequisite. Use picks one. */
export function ServiceTypesTab({ types, picked, onUse, onRequest }: { types: ServiceTypeChoice[] | null; picked: string | null; onUse: (t: ServiceTypeChoice) => void; onRequest?: () => void }) {
  const [query, setQuery] = useState("")
  const shown = useMemo(() => (types ?? []).filter((t) => matches(query, t.name, t.key, t.region, categoryLabel(t.category), t.description)), [types, query])
  return (
    <PanelTable id="service-types" query={query} onQuery={setQuery} searchLabel="Search service types" cta={onRequest && <RequestButton onRequest={onRequest} />}>
      {types === null ? (
        <Skeleton className="m-3 h-4" data-loading />
      ) : (
        <AdminTable
          head={["Service type", "Region", "Category", "What it does", "Licence prerequisite", ""]}
          rowKeys={shown.map(typeChoiceId)}
          rows={shown.map((t) => [
            <span key="n" className="flex flex-col">
              {t.name}
              <code className="text-xs font-normal text-muted-foreground">{t.key}</code>
            </span>,
            t.region,
            categoryLabel(t.category),
            <span key="d" className="block max-w-80 truncate" title={t.description}>
              {t.description || "Not described"}
            </span>,
            <span key="l" data-licence-prerequisite>
              {licencePrerequisite(t)}
            </span>,
            <span key="a" className="flex justify-end">
              <Button size="sm" variant="outline" onClick={() => onUse(t)} disabled={typeChoiceId(t) === picked} data-use-service-type={typeChoiceId(t)}>
                {typeChoiceId(t) === picked ? "Picked" : "Use"}
              </Button>
            </span>,
          ])}
          empty={types.length ? "No service types match." : "Mynt has no service types yet. Request one."}
        />
      )}
    </PanelTable>
  )
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—")

/** The service types this account (or its firm) asked Mynt for, with where each stands. `admin`: every request, with who asked. */
export function TypeRequestsTable({ requests, onOpen, admin = false }: { requests: ServiceTypeRequest[]; onOpen?: (r: ServiceTypeRequest) => void; admin?: boolean }) {
  return (
    <AdminTable
      head={admin ? ["Requested", "Name", "Region", "Firm", "Requested by", "Status"] : ["Requested", "Name", "Region", "Status", "Mynt's answer"]}
      rowKeys={requests.map((r) => r.id)}
      onRow={onOpen ? (i) => onOpen(requests[i]) : undefined}
      rows={requests.map((r) => {
        const name = onOpen ? (
          <button key="n" type="button" className="text-left underline-offset-4 hover:underline" onClick={() => onOpen(r)} data-open-type-request={r.id}>
            {r.name}
          </button>
        ) : (
          r.name
        )
        const status = (
          <span key="s" data-request-status={r.status}>
            {r.statusWords}
          </span>
        )
        return admin
          ? [day(r.requestedAt), name, r.region, r.firm ?? "No firm", r.requestedBy ?? "Not known", status]
          : [day(r.requestedAt), name, r.region, status, r.status === "defined" ? `Defined as ${r.serviceTypeKey ?? "a service type"}` : (r.decisionNote ?? "Not answered yet")]
      })}
      empty={admin ? "Nobody has asked for a service type." : "You haven't asked Mynt for a service type."}
    />
  )
}

export function TypeRequestsTab({ requests, onRequest }: { requests: ServiceTypeRequest[] | null; onRequest?: () => void }) {
  const [query, setQuery] = useState("")
  const shown = useMemo(() => (requests ?? []).filter((r) => matches(query, r.name, r.region, r.statusWords, r.whatItDoes)), [requests, query])
  return (
    <PanelTable id="service-type-requests" query={query} onQuery={setQuery} searchLabel="Search your requested service types" cta={onRequest && <RequestButton onRequest={onRequest} />}>
      {requests === null ? (
        <p className="p-4 text-sm text-muted-foreground" data-requests-unavailable>
          Not available. Requesting a service type comes with Mynt&apos;s next update.
        </p>
      ) : (
        <TypeRequestsTable requests={shown} />
      )}
    </PanelTable>
  )
}

// ---- Request a service type ----

const EXAMPLE = "{\n  \n}"

export function RequestServiceTypeSheet({ open, onClose, onDone, fetcher }: { open: boolean; onClose: () => void; onDone?: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [f, setF] = useState({ name: "", what: "", region: "US", input: EXAMPLE, output: EXAMPLE })
  const [invalid, setInvalid] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    reset()
    setInvalid(null)
  }, [open, reset])
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }))
  return (
    <AdminSheet
      id="request-service-type"
      open={open}
      onClose={onClose}
      title="Request a service type"
      description="Service types are defined by Mynt's admins. Say what yours is called and does, with one example of what it takes in and gives back. An admin defines it from your request, or declines with a reason."
      error={invalid ?? error}
      result={result}
    >
      <form
        className="flex flex-col gap-3"
        data-request-type-form
        onSubmit={async (e) => {
          e.preventDefault()
          const input = jsonObjectOf(f.input)
          const output = jsonObjectOf(f.output)
          if (f.name.trim().length < 3) return setInvalid("Give it a name (at least 3 characters).")
          if (f.what.trim().length < 10) return setInvalid("Say what it does (at least 10 characters).")
          if (!/^[A-Za-z]{2}$/.test(f.region.trim())) return setInvalid("The region is two letters, e.g. US.")
          if (!input.ok) return setInvalid(`Example input: ${input.error}`)
          if (!output.ok) return setInvalid(`Example output: ${output.error}`)
          setInvalid(null)
          const r = await run("/api/services/types", { name: f.name.trim(), what_it_does: f.what.trim(), region: f.region.trim().toUpperCase(), example_input: input.value, example_output: output.value })
          if (r?.ok) onDone?.()
        }}
      >
        <Field label="Name" hint="What the service type is called, e.g. Proof of address">
          <Input value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} required data-request-name />
        </Field>
        <Field label="What it does">
          <textarea className={`${fieldClass} min-h-20`} value={f.what} onChange={(e) => set({ what: e.target.value })} maxLength={2000} required data-request-what />
        </Field>
        <Field label="Region" hint="Two letters, e.g. US">
          <Input value={f.region} onChange={(e) => set({ region: e.target.value })} maxLength={2} required data-request-region />
        </Field>
        <Field label="Example input (JSON)" hint="One JSON object: what the service takes in">
          <textarea className={`${fieldClass} min-h-28 font-mono text-xs`} value={f.input} onChange={(e) => set({ input: e.target.value })} spellCheck={false} data-request-input />
        </Field>
        <Field label="Example output (JSON)" hint="One JSON object: what it gives back">
          <textarea className={`${fieldClass} min-h-28 font-mono text-xs`} value={f.output} onChange={(e) => set({ output: e.target.value })} spellCheck={false} data-request-output />
        </Field>
        <div>
          <Button type="submit" disabled={busy || result !== null} data-request-type-submit>
            {busy ? "Sending…" : "Request service type"}
          </Button>
        </div>
      </form>
    </AdminSheet>
  )
}
