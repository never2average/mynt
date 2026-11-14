"use client";

// Coverage: where the selected workspace's products can serve customers (components/coverage-view.tsx).
import { CoverageView } from "@/components/coverage-view";
import { NotReady } from "@/components/not-available";
import type { Coverage } from "@/lib/compliance";
import { useComplianceData } from "@/lib/use-compliance";

const pick = (body: Record<string, unknown>) => body.coverage as Coverage | undefined;

export default function CoveragePage() {
  const { state } = useComplianceData("/api/coverage", pick);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl p-4 lg:p-6">
        {state.kind === "ready" ? <CoverageView coverage={state.data} /> : <NotReady state={state} what="Coverage" />}
      </div>
    </div>
  );
}
