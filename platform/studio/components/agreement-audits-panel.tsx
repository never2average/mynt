"use client"

// The agreement audits list with its data (/api/agreement-audits) and its sheets, shared by the Audits page's
// Agreement audits tab and the Licences page's Audit obligations tab (components/agreement-audits-view.tsx). On the
// Audits page it acts: Add audit requirement, and each audit's actions for the caller's side. With readOnly (Audit
// obligations) it only presents the obligations: no call to action, and the sheet shows an audit without its actions.
import { useState } from "react"

import { AddRequirementSheet, AgreementAuditSheet, AgreementAuditsView } from "@/components/agreement-audits-view"
import { NotReady } from "@/components/not-available"
import { NO_AGREEMENT_AUDIT_FILTERS, OVERDUE, type AgreementAuditList, type AgreementAuditRow } from "@/lib/agreement-audits"
import { useComplianceData } from "@/lib/use-compliance"

type AgreementAuditsData = { list: AgreementAuditList; canAddRequirement: boolean }
export const pickAgreementAudits = (body: Record<string, unknown>) =>
  body.list ? ({ list: body.list as AgreementAuditList, canAddRequirement: body.canAddRequirement === true } as AgreementAuditsData) : undefined

export function AgreementAuditsPanel({ agreement = "", overdue = false, readOnly = false }: { agreement?: string; overdue?: boolean; readOnly?: boolean }) {
  const { state, reload } = useComplianceData("/api/agreement-audits", pickAgreementAudits)
  const [open, setOpen] = useState<AgreementAuditRow | null>(null)
  const [adding, setAdding] = useState(false)
  if (state.kind !== "ready") return <NotReady state={state} what={readOnly ? "Audit obligations" : "Agreement audits"} />
  const initial = { ...NO_AGREEMENT_AUDIT_FILTERS, agreement: agreement ? [agreement] : [], status: overdue ? [OVERDUE] : [] }
  return (
    <>
      <AgreementAuditsView
        list={state.data.list}
        initial={initial}
        canAddRequirement={!readOnly && state.data.canAddRequirement}
        onOpen={setOpen}
        onAddRequirement={readOnly ? undefined : () => setAdding(true)}
      />
      <AgreementAuditSheet auditId={open?.id ?? null} title={open?.name ?? "Audit"} open={open !== null} onClose={() => setOpen(null)} onChanged={reload} readOnly={readOnly} />
      {!readOnly && <AddRequirementSheet agreements={state.data.list.agreements} open={adding} onClose={() => setAdding(false)} onDone={reload} />}
    </>
  )
}
