"use client"

// A page's own tabs in the page header, beside its title (the header is the layout's, so the page
// puts them there through a portal into the header's slot). Until the header is mounted, nothing.
import { useEffect, useState } from "react"
import { createPortal } from "react-dom"

import { HEADER_TABS_ID } from "@/components/site-header"

export function HeaderTabs({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  useEffect(() => setSlot(document.getElementById(HEADER_TABS_ID)), [])
  return slot ? createPortal(children, slot) : null
}
