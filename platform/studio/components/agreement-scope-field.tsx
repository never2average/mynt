"use client"

// The Scope of an agreement, on every Propose agreement sheet and Change scope: one or more of Mynt's fixed list
// (AGREEMENT_SCOPES), each a labelled checkbox. Required: the sheet's submit waits until at least one is ticked.
import { AGREEMENT_SCOPES, type AgreementScope } from "@/lib/app-panel"

export function ScopeField({ value, onChange }: { value: AgreementScope[]; onChange: (next: AgreementScope[]) => void }) {
  return (
    <fieldset className="flex flex-col gap-1 text-sm" data-propose-scopes>
      <legend className="mb-1">Scope (at least one)</legend>
      {AGREEMENT_SCOPES.map((s) => (
        <label key={s.key} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={value.includes(s.key)}
            onChange={(e) => onChange(e.target.checked ? AGREEMENT_SCOPES.map((x) => x.key).filter((k) => k === s.key || value.includes(k)) : value.filter((k) => k !== s.key))}
            data-propose-scope={s.key}
          />
          {s.label}
        </label>
      ))}
      {!value.length && <span className="text-xs text-muted-foreground">Choose what the agreement covers.</span>}
    </fieldset>
  )
}
