"use client"

// Admin → Firms: every firm registered on Mynt (list_entities), each a licence provider, a vendor, a liquidity
// provider or an innovator by its members' roles. Firms are added by hand by Mynt's admins: Register firm
// (register_firm) adds one with no members. A row's Open shows the firm: its metadata card with Invite member (an
// email allowed to sign in with the roles picked, invite_user, then added to the firm, add_entity_member) and Set firm
// status (set_entity_status), then Members, Licences, Offerings and Products, each a table. What a firm keeps to
// itself (its encrypted health books, its signatures) isn't here: admins can't read or co-sign them. Server-renderable.
import { useCallback, useEffect, useMemo, useState } from "react"
import { Building2, ShieldAlert, UserPlus } from "lucide-react"

import { AdminDetail, AdminList, AdminNotReady, AdminSheet, AdminTable, Field, fieldClass, useAdminAction, useAdminData } from "@/components/admin-kit"
import { downloadCsv } from "@/components/licences-view"
import { matches, usePaged } from "@/components/list-layout"
import { StageMark, StatusDot } from "@/components/promotion-view"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { conformanceWords, csvOf, dateOf, FIRM_TYPE_LABELS, FIRM_TYPES, words, type AdminOffering, type AdminProduct, type Firm } from "@/lib/admin"
import type { Stage } from "@/lib/workspaces"

const typesOf = (f: Firm) => f.types.map((t) => FIRM_TYPE_LABELS[t]).join(", ") || "No members yet"
export const LEGAL_FORMS = ["company_private", "company_public", "llp", "partnership", "sole_proprietorship", "trust", "cooperative", "society", "nonprofit_company", "statutory_corporation", "government_entity", "foreign_branch"] as const
// The roles a firm's people are invited with (Mynt's admin role is never given from here).
export const MEMBER_ROLES = [
  { value: "developer", label: "Innovator (builds products and apps)" },
  { value: "vendor", label: "Vendor (offers standard services)" },
  { value: "license_provider", label: "Licence provider (sponsors products)" },
  { value: "liquidity_provider", label: "Liquidity provider (puts capital into pools)" },
] as const

export function FirmStatus({ status }: { status: string }) {
  return <StatusDot tone={status === "active" ? "green" : status === "suspended" ? "amber" : "red"} label={words(status)} data-firm-status={status} />
}

/** Register firm: a legal entity added by hand, with no members yet. */
export function RegisterFirmSheet({ open, onClose, onDone, fetcher }: { open: boolean; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [name, setName] = useState("")
  const [legalForm, setLegalForm] = useState("")
  const [country, setCountry] = useState("us")
  const [regions, setRegions] = useState("US")
  const [lei, setLei] = useState("")
  useEffect(() => {
    if (open) reset()
  }, [open, reset])
  return (
    <AdminSheet id="register-firm" open={open} onClose={onClose} title="Register firm" description="Adds a firm to Mynt by hand, with no members yet. Invite its people next, from the firm's page." error={error} result={result}>
      <form
        className="flex flex-col gap-3"
        data-register-firm-form
        onSubmit={async (e) => {
          e.preventDefault()
          const body = {
            name: name.trim(),
            ...(legalForm ? { legal_form: legalForm } : {}),
            ...(country.trim() ? { incorporation: { country: country.trim().toLowerCase() } } : {}),
            regions: regions.split(/[\s,]+/).map((r) => r.trim()).filter(Boolean).map((r) => (r.toLowerCase() === "global" ? "global" : r.toUpperCase())),
            ...(lei.trim() ? { identifiers: [{ scheme: "lei", value: lei.trim() }] } : {}),
          }
          const r = await run("/api/admin/firms", body)
          if (r?.ok) onDone()
        }}
      >
        <Field label="Legal name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required data-firm-name />
        </Field>
        <Field label="Legal form">
          <select className={fieldClass} value={legalForm} onChange={(e) => setLegalForm(e.target.value)} data-firm-legal-form>
            <option value="">Not recorded</option>
            {LEGAL_FORMS.map((f) => (
              <option key={f} value={f}>
                {words(f)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Country of incorporation" hint="Two letters, e.g. us">
          <Input value={country} onChange={(e) => setCountry(e.target.value)} maxLength={2} data-firm-country />
        </Field>
        <Field label="Regions it operates in" hint="Country codes or global, separated by commas">
          <Input value={regions} onChange={(e) => setRegions(e.target.value)} maxLength={200} data-firm-regions />
        </Field>
        <Field label="LEI (optional)" hint="Mynt checks it against GLEIF's public record">
          <Input value={lei} onChange={(e) => setLei(e.target.value)} maxLength={100} data-firm-lei />
        </Field>
        <div>
          <Button type="submit" disabled={busy || !name.trim()} data-register-firm-submit>
            {busy ? "Registering…" : "Register firm"}
          </Button>
        </div>
      </form>
    </AdminSheet>
  )
}

/** Invite member: an email allowed to sign in with the roles picked, then added to the firm. */
export function InviteMemberSheet({ firm, open, onClose, onDone, fetcher }: { firm: Firm; open: boolean; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [email, setEmail] = useState("")
  const [roles, setRoles] = useState<string[]>(() => (firm.types.length ? firm.types.map((t) => (t === "builder" ? "developer" : t)) : ["developer"]))
  useEffect(() => {
    if (open) reset()
  }, [open, reset])
  const toggle = (r: string) => setRoles((rs) => (rs.includes(r) ? rs.filter((x) => x !== r) : [...rs, r]))
  return (
    <AdminSheet id="invite-member" open={open} onClose={onClose} title="Invite member" description={`Lets someone sign in to Mynt with the roles you pick, and makes them a member of ${firm.name}. Its members are told.`} error={error} result={result}>
      <form
        className="flex flex-col gap-3"
        data-invite-member-form
        onSubmit={async (e) => {
          e.preventDefault()
          const r = await run(`/api/admin/firms/${encodeURIComponent(firm.id)}/members`, { email: email.trim(), roles })
          if (r?.ok) onDone()
        }}
      >
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} required data-member-email />
        </Field>
        <fieldset className="flex flex-col gap-2 text-sm" data-member-roles>
          <legend className="mb-1">Roles</legend>
          {MEMBER_ROLES.map((r) => (
            <label key={r.value} className="flex items-center gap-2">
              <input type="checkbox" checked={roles.includes(r.value)} onChange={() => toggle(r.value)} data-role={r.value} />
              {r.label}
            </label>
          ))}
        </fieldset>
        <div>
          <Button type="submit" disabled={busy || !email.trim() || !roles.length} data-invite-member-submit>
            {busy ? "Inviting…" : "Invite member"}
          </Button>
        </div>
      </form>
    </AdminSheet>
  )
}

const ENTITY_STATUSES = ["active", "suspended", "under_liquidation", "dissolved", "struck_off"] as const

/** Set firm status: from its company registry, with a note. Products resting on it are re-checked. */
export function FirmStatusSheet({ firm, open, onClose, onDone, fetcher }: { firm: Firm; open: boolean; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [status, setStatus] = useState(firm.status)
  const [note, setNote] = useState("")
  useEffect(() => {
    if (open) reset()
  }, [open, reset])
  return (
    <AdminSheet id="firm-status" open={open} onClose={onClose} title="Set firm status" description="Record the firm's status from its company registry. Every published product resting on it is re-checked; drifted ones pause new sales." error={error} result={result}>
      <form
        className="flex flex-col gap-3"
        data-firm-status-form
        onSubmit={async (e) => {
          e.preventDefault()
          const r = await run(`/api/admin/firms/${encodeURIComponent(firm.id)}/status`, { status, note: note.trim() })
          if (r?.ok) onDone()
        }}
      >
        <Field label="Status">
          <select className={fieldClass} value={status} onChange={(e) => setStatus(e.target.value)} data-firm-status-select>
            {ENTITY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {words(s)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note: where this comes from">
          <textarea className={`${fieldClass} min-h-20`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} required data-firm-status-note />
        </Field>
        <div>
          <Button type="submit" disabled={busy || note.trim().length < 3} data-firm-status-submit>
            {busy ? "Saving…" : "Set firm status"}
          </Button>
        </div>
      </form>
    </AdminSheet>
  )
}

export function FirmsListView({ firms, onOpen, onChanged = () => undefined, sheetOpen = false }: { firms: Firm[]; onOpen: (id: string) => void; onChanged?: () => void; sheetOpen?: boolean }) {
  const [query, setQuery] = useState("")
  const [type, setType] = useState<string[]>([])
  const [status, setStatus] = useState<string[]>([])
  const [registering, setRegistering] = useState(sheetOpen)
  // The list is read again once the sheet closes, so its answer stays on screen until then.
  const [dirty, setDirty] = useState(false)
  const shown = useMemo(
    () =>
      firms.filter(
        (f) =>
          matches(query, f.name, f.id, ...f.members.map((m) => m.email)) &&
          (!type.length || type.some((t) => (t === "none" ? !f.types.length : f.types.includes(t as Firm["types"][number])))) &&
          (!status.length || status.includes(f.status)),
      ),
    [firms, query, type, status],
  )
  const { page, pages, shown: onPage, setPage } = usePaged(shown)
  const exportCsv = () =>
    downloadCsv("firms.csv", csvOf(["Firm", "Type", "Status", "Members", "Licences", "Country", "Created", "Id"], shown.map((f) => [f.name, typesOf(f), f.status, f.members.length, f.licences.length, f.country ?? "", dateOf(f.createdAt), f.id])))
  return (
    <>
      <AdminList
        id="firms"
        search={query}
        onSearch={(q) => (setQuery(q), setPage(1))}
        searchLabel="Search firms by name, member email or id"
        facets={[
          { id: "type", label: "Type", options: [...FIRM_TYPES.map((t) => ({ value: t, label: FIRM_TYPE_LABELS[t] })), { value: "none", label: "No members yet" }], selected: type, onChange: (v) => (setType(v), setPage(1)) },
          { id: "status", label: "Status", options: ENTITY_STATUSES.map((s) => ({ value: s, label: words(s) })), selected: status, onChange: (v) => (setStatus(v), setPage(1)) },
        ]}
        onClearFilters={() => (setType([]), setStatus([]))}
        onExport={exportCsv}
        exportDisabled={!shown.length}
        cta={
          <Button onClick={() => setRegistering(true)} data-register-firm>
            <Building2 />
            Register firm
          </Button>
        }
        page={page}
        pages={pages}
        total={shown.length}
        onPage={setPage}
      >
        <AdminTable
          head={["Firm", "Type", "Status", "Members", "Licences", "Country", "Created", ""]}
          rowKeys={onPage.map((f) => f.id)}
          rows={onPage.map((f) => [
            f.name,
            typesOf(f),
            <FirmStatus key="s" status={f.status} />,
            String(f.members.length),
            String(f.licences.length),
            f.country?.toUpperCase() ?? "—",
            dateOf(f.createdAt),
            <Button key="o" size="sm" variant="outline" onClick={() => onOpen(f.id)} data-open-firm={f.id}>
              Open
            </Button>,
          ])}
          empty={firms.length ? "No firms match these filters." : "No firms yet. Register the first one."}
        />
      </AdminList>
      <RegisterFirmSheet
        open={registering}
        onClose={() => {
          setRegistering(false)
          if (dirty) onChanged()
        }}
        onDone={() => setDirty(true)}
      />
    </>
  )
}

type DetailTab = "members" | "licences" | "offerings" | "products"
const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: "members", label: "Members" },
  { id: "licences", label: "Licences" },
  { id: "offerings", label: "Offerings" },
  { id: "products", label: "Products" },
]
export type FirmDetail = { firm: Firm; offerings: AdminOffering[] | null; products: AdminProduct[] | null }

export function FirmDetailView({ detail, onBack, onChanged = () => undefined, initialTab = "members", sheet = null }: { detail: FirmDetail; onBack: () => void; onChanged?: () => void; initialTab?: DetailTab; sheet?: "invite" | "status" | null }) {
  const [tab, setTab] = useState<DetailTab>(initialTab)
  const [open, setOpen] = useState<"invite" | "status" | null>(sheet)
  const [dirty, setDirty] = useState(false)
  const close = () => {
    setOpen(null)
    if (dirty) onChanged()
  }
  const f = detail.firm
  return (
    <>
      <AdminDetail
        backLabel="Back to firms"
        onBack={onBack}
        title={f.name}
        subtitle={typesOf(f)}
        fields={[
          ["Status", <FirmStatus key="s" status={f.status} />],
          ["Legal form", words(f.legalForm)],
          ["Country", f.country?.toUpperCase() ?? "—"],
          ["Regions", f.regions.join(", ") || "—"],
          ["Members", String(f.members.length)],
          ["Licences", String(f.licences.length)],
          ["Registered", dateOf(f.createdAt)],
          ["Id", <code key="i" className="text-xs">{f.id}</code>],
        ]}
        actions={
          <>
            <Button size="sm" onClick={() => setOpen("invite")} data-invite-member>
              <UserPlus />
              Invite member
            </Button>
            <Button size="sm" variant="outline" onClick={() => setOpen("status")} data-set-firm-status>
              <ShieldAlert />
              Set firm status
            </Button>
          </>
        }
        tabs={DETAIL_TABS}
        tab={tab}
        onTab={setTab}
      >
        {tab === "members" && (
          <AdminTable head={["Name", "Email", "Roles"]} rowKeys={f.members.map((m) => m.id)} rows={f.members.map((m) => [m.name ?? "—", m.email ?? "—", m.roles.map(words).join(", ") || "—"])} empty="No members yet. Invite its people." />
        )}
        {tab === "licences" && (
          <AdminTable
            head={["Licence", "Regulator", "Region", "Jurisdiction", "Number", "Valid to", "Review"]}
            rowKeys={f.licences.map((l) => l.id)}
            rows={f.licences.map((l) => [l.licenceType, l.regulator, l.region, l.jurisdiction ?? "—", l.number ?? "—", dateOf(l.validTo), words(l.status)])}
            empty="No licences registered."
          />
        )}
        {tab === "offerings" &&
          (detail.offerings === null ? (
            <p className="p-4 text-sm text-muted-foreground">Vendors&apos; offerings aren&apos;t available on this Mynt yet.</p>
          ) : (
            <AdminTable
              head={["Offering", "Service", "Region", "Status", "Conformance"]}
              rowKeys={detail.offerings.map((o) => o.id)}
              rows={detail.offerings.map((o) => [o.name, o.serviceName, o.region, words(o.status), conformanceWords(o.conformance)])}
              empty="This firm offers no standard services."
            />
          ))}
        {tab === "products" &&
          (detail.products === null ? (
            <p className="p-4 text-sm text-muted-foreground">The products across firms aren&apos;t available on this Mynt yet.</p>
          ) : (
            <AdminTable
              head={["Product", "This firm", "Stage", "Status"]}
              rowKeys={detail.products.map((p) => p.id)}
              rows={detail.products.map((p) => {
                const s = p.sponsors.find((x) => x.entityId === f.id)
                return [p.name, p.firm?.id === f.id ? "Owns it" : `Sponsors it${s?.status === "pending" ? " (pending)" : ""}`, <StageMark key="s" stage={p.stage as Stage} />, words(p.status)]
              })}
              empty="This firm owns and sponsors no products."
            />
          ))}
      </AdminDetail>
      <InviteMemberSheet firm={f} open={open === "invite"} onClose={close} onDone={() => setDirty(true)} />
      <FirmStatusSheet firm={f} open={open === "status"} onClose={close} onDone={() => setDirty(true)} />
    </>
  )
}

export function FirmsTab({ id, onOpen, onBack }: { id: string | null; onOpen: (id: string) => void; onBack: () => void }) {
  const pickList = useCallback((b: Record<string, unknown>) => (Array.isArray(b.firms) ? (b.firms as Firm[]) : undefined), [])
  const pickOne = useCallback((b: Record<string, unknown>) => (b.firm ? ({ firm: b.firm, offerings: b.offerings ?? null, products: b.products ?? null } as FirmDetail) : undefined), [])
  const list = useAdminData(id ? null : "/api/admin/firms", pickList)
  const one = useAdminData(id ? `/api/admin/firms/${encodeURIComponent(id)}` : null, pickOne)
  if (id) return one.state.kind === "ready" ? <FirmDetailView detail={one.state.data} onBack={onBack} onChanged={one.reload} /> : <AdminNotReady state={one.state} what="This firm" />
  return list.state.kind === "ready" ? <FirmsListView firms={list.state.data} onOpen={onOpen} onChanged={list.reload} /> : <AdminNotReady state={list.state} what="Firms" />
}
