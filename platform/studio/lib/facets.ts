// A list filter's facets (the Filters popover's headings, components/filter-controls.tsx): each
// takes any number of picks, and a row matches a facet when it is any of them. Plain functions, so
// lib code and server code can filter with them too.

/** A facet's filter value: any number of picks, or one (an older single-value filter or query param). */
export type Picks = string | readonly string[]

/** A facet's picks as a list, from one value or many ("" or none for no picks). */
export const picksOf = (v: Picks | null | undefined): string[] => (typeof v === "string" ? (v ? [v] : []) : v ? v.filter(Boolean) : [])

/** Whether `value` is any of a facet's picks (always true with none picked). Several values (a row's states) match if any does. */
export const anyOf = (v: Picks | null | undefined, value: string | null | undefined | readonly (string | null)[]) => {
  const picks = picksOf(v)
  if (!picks.length) return true
  const values = Array.isArray(value) ? value : [value]
  return values.some((x) => x != null && picks.includes(x))
}
