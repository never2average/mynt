// What needs the workspace's attention (get_workspace_attention), for the dashboard's Needs
// attention card. Read defensively: an item without a title is left out, and only links to a
// studio page are kept as links (anything else is shown as plain text).
import { isStudioPath } from "./studio-search";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export const SEVERITIES = ["high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_LABELS: Record<Severity, string> = { high: "High", medium: "Medium", low: "Low" };

export type AttentionItem = {
  id: string;
  kind: string | null;
  severity: Severity;
  title: string;
  detail: string | null;
  href: string | null;
  linkText: string | null; // a link that isn't a studio page, shown as plain text
  at: string | null;
};

// Only a studio page is a link; anything else (another site, even over https) shows as plain text.
function link(v: unknown): { href: string | null; linkText: string | null } {
  const raw = str(v);
  if (!raw) return { href: null, linkText: null };
  const shown = raw.slice(0, 300); // isStudioPath narrows raw, so take the text first
  return isStudioPath(raw) ? { href: raw, linkText: null } : { href: null, linkText: shown };
}

// Most severe first, then newest.
export function fromAttention(reply: unknown): AttentionItem[] {
  const list = isObj(reply) && Array.isArray(reply.items) ? reply.items : [];
  const items = list.filter(isObj).flatMap((v, i): AttentionItem[] => {
    const title = str(v.title);
    if (!title) return [];
    const severity = SEVERITIES.find((s) => s === v.severity) ?? "low";
    return [{ id: str(v.id) ?? `item-${i}`, kind: str(v.kind), severity, title, detail: str(v.detail), ...link(v.href), at: str(v.at) }];
  });
  return items.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || (b.at ?? "").localeCompare(a.at ?? ""));
}
