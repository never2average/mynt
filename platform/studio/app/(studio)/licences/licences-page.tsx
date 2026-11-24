"use client";

// Licences: four tabs in the page body under the header (lib/licences-tabs.ts), each open to developers and licence
// providers alike, each showing what the person's side holds. No row of figures above them.
// - Business agreements: program and data-sharing agreements (components/lp-agreements-view.tsx). Either side
//   proposes (Propose agreement); the other accepts or declines; both sign.
// - MSA: master services agreements between a firm and a workspace, the same way (Propose MSA); below them, a licence
//   provider's agreement templates, the starting documents it proposes from (Upload agreement template, Retire).
// - SLA: service level agreements (Propose SLA), each with its Commitments and Breaches in its detail
//   (components/agreement-slas-view.tsx): Add commitment before it's signed, Record breach and Resolve breach after.
// - Audit obligations: the oversight audits under program agreements, shown only (components/agreement-audits-panel.tsx);
//   they're acted on from the Audits page.
import { useCallback, useState } from "react";
import { FilePlus2 } from "lucide-react";

import { AgreementAuditsPanel } from "@/components/agreement-audits-panel";
import { AgreementTemplatesSection, useAgreementTemplates } from "@/components/agreement-esign";
import { SlaSheet, slaDetailTabs, type SlaSheetMode } from "@/components/agreement-slas-view";
import { LpAgreementsView, pickAgreements, type AgreementsData } from "@/components/lp-agreements-view";
import { NotReady } from "@/components/not-available";
import { Button } from "@/components/ui/button";
import { Tab, TabList } from "@/components/ui/tabs";
import type { SlaList } from "@/lib/agreement-slas";
import { LICENCES_TAB_LABELS, LICENCES_TABS, licencesHref, type LicencesTab } from "@/lib/licences-tabs";
import { TAB_KINDS } from "@/lib/lp-agreements";
import { useComplianceData, type Loaded } from "@/lib/use-compliance";
import { useStudioAccess } from "@/lib/use-liquidity-access";

export function LicencesTabs({ tab, onTab }: { tab: LicencesTab; onTab: (t: LicencesTab) => void }) {
  return (
    <TabList aria-label="Licences" data-licences-tabs>
      {LICENCES_TABS.map((t) => (
        <Tab key={t} selected={tab === t} data-tab={t} onClick={() => onTab(t)}>
          {LICENCES_TAB_LABELS[t]}
        </Tab>
      ))}
    </TabList>
  );
}

const pickSlas = (body: Record<string, unknown>) => (body.list ? (body.list as SlaList) : undefined);

function AgreementsTab({ state, reload, children }: { state: Loaded<AgreementsData>; reload: () => void; children: (data: AgreementsData, reload: () => void) => React.ReactNode }) {
  if (state.kind !== "ready") return <NotReady state={state} what="Agreements" />;
  return <>{children(state.data, reload)}</>;
}

function MsaTab({ state, reload, licenceProvider }: { state: Loaded<AgreementsData>; reload: () => void; licenceProvider: boolean }) {
  const { state: templates, reload: reloadTemplates } = useAgreementTemplates(licenceProvider);
  return (
    <AgreementsTab state={state} reload={reload}>
      {(data) => (
        <div className="flex min-h-0 flex-1 flex-col gap-6">
          <LpAgreementsView
            rows={data.agreements}
            kinds={TAB_KINDS.msa}
            targets={data.targets}
            templates={templates.kind === "ready" ? templates.data.templates : []}
            onChanged={reload}
            auditRequirements={false}
            csvName="msas.csv"
            ctaLabel="Propose MSA"
            empty="No master services agreements yet. Either side proposes one: the firm to a workspace building on its products, or the workspace to the firm."
          />
          {licenceProvider && templates.kind === "ready" && <AgreementTemplatesSection data={templates.data} onChanged={reloadTemplates} />}
          {licenceProvider && templates.kind === "error" && (
            <p role="alert" className="text-sm text-destructive">
              {templates.message}
            </p>
          )}
        </div>
      )}
    </AgreementsTab>
  );
}

function SlaTab({ state, reload }: { state: Loaded<AgreementsData>; reload: () => void }) {
  const { state: slas, reload: reloadSlas } = useComplianceData("/api/agreement-slas", pickSlas);
  const [sheet, setSheet] = useState<SlaSheetMode | null>(null);
  const list = slas.kind === "ready" ? slas.data : { slas: [], canAdd: [] };
  const both = useCallback(() => {
    reload();
    reloadSlas();
  }, [reload, reloadSlas]);
  return (
    <AgreementsTab state={state} reload={reload}>
      {(data) => (
        <>
          <LpAgreementsView
            rows={data.agreements}
            kinds={TAB_KINDS.sla}
            targets={data.targets}
            onChanged={both}
            auditRequirements={false}
            csvName="slas.csv"
            ctaLabel="Propose SLA"
            empty="No service level agreements yet. Either side proposes one; its commitments are in force once both sides have signed."
            detailTabs={(row) => slaDetailTabs(list.slas.filter((s) => s.agreementId === row.id), setSheet)}
            detailActions={(row) =>
              list.canAdd.includes(row.id) ? (
                <Button size="sm" variant="outline" className="h-7" onClick={() => setSheet({ kind: "add", agreementId: row.id, title: `A commitment of the ${row.kind.toLowerCase()} with ${row.side === "app" ? row.counterparty : row.workspace}.` })} data-add-sla={row.id}>
                  <FilePlus2 />
                  Add commitment
                </Button>
              ) : null
            }
          />
          {slas.kind === "unsupported" && <p className="text-sm text-muted-foreground">SLA commitments and breaches come with Mynt&apos;s next update.</p>}
          <SlaSheet mode={sheet} onClose={() => setSheet(null)} onDone={reloadSlas} />
        </>
      )}
    </AgreementsTab>
  );
}

export function LicencesPage({ initialTab = "business-agreements" }: { initialTab?: LicencesTab }) {
  const access = useStudioAccess();
  const [tab, setTab] = useState<LicencesTab>(initialTab);
  // The agreement tabs share one read of the agreements (/api/agreements), from both sides.
  const { state, reload } = useComplianceData("/api/agreements", pickAgreements);
  const onTab = (t: LicencesTab) => {
    setTab(t);
    window.history.replaceState(null, "", licencesHref(t));
  };
  return (
    <div className="@container/main flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex min-h-0 w-full flex-1 flex-col gap-4 p-4 lg:gap-5 lg:p-6">
        <LicencesTabs tab={tab} onTab={onTab} />
        <div className="flex min-h-0 flex-1 flex-col gap-3" data-tab-panel={tab}>
          {tab === "business-agreements" ? (
            <AgreementsTab state={state} reload={reload}>
              {(data) => <LpAgreementsView rows={data.agreements} kinds={TAB_KINDS.business} targets={data.targets} onChanged={reload} />}
            </AgreementsTab>
          ) : tab === "msa" ? (
            <MsaTab state={state} reload={reload} licenceProvider={Boolean(access?.licenceProvider)} />
          ) : tab === "sla" ? (
            <SlaTab state={state} reload={reload} />
          ) : (
            <AgreementAuditsPanel readOnly />
          )}
        </div>
      </div>
    </div>
  );
}
