// A date as "Nov 20, 2026" (UTC), or null when there isn't a valid one. Shared by the Settings tables and the
// header's GitHub menu, kept apart from the views so importing it doesn't pull in their charts.
export const dateOf = (iso: string | null | undefined) =>
  iso && !Number.isNaN(new Date(iso).getTime()) ? new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : null
