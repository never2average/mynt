"use client"

// The seven risk-area tabs the platform admin's Risk models and Risk register share (line tabs, lib/risk-register.ts
// RISK_AREAS): Financial risk · Compliance risk · Third-party risk · Operations risk · Business process risk ·
// Technology risk · Regulated product risk. Tabs only show; the tab lives in the address (?tab=<area>).
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useCallback } from "react"

import { Tab, TabList } from "@/components/ui/tabs"
import { RISK_AREA_LABELS, RISK_AREAS, type RiskArea } from "@/lib/risk-register"
import { areaFromQuery } from "@/lib/risk-models"

export function RiskAreaTabs({ area, onArea, label }: { area: RiskArea; onArea: (a: RiskArea) => void; label: string }) {
  return (
    <TabList aria-label={label} data-risk-area-tabs>
      {RISK_AREAS.map((a) => (
        <Tab key={a} selected={a === area} onClick={() => onArea(a)} data-risk-area-tab={a}>
          {RISK_AREA_LABELS[a]}
        </Tab>
      ))}
    </TabList>
  )
}

/** The area the address names (?tab=…), the first otherwise, and a way to change it in the address. */
export function useAreaInAddress(): [RiskArea, (a: RiskArea) => void] {
  const router = useRouter()
  const pathname = usePathname()
  const query = useSearchParams()
  const area = areaFromQuery(query?.get("tab"))
  const set = useCallback((a: RiskArea) => router.replace(`${pathname}?tab=${a}`), [router, pathname])
  return [area, set]
}
