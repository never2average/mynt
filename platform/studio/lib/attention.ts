// What needs the workspace's attention (get_workspace_attention), for the dashboard's Needs
// attention card. Read defensively: an item without a title is left out, and only links to a
// studio page or an https page are kept.
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
  external: boolean;
  at: string | null;
};

function link(v: unknown): { href: string | null; external: boolean } {
  const raw = str(v);
  if (!raw) return { href: null, external: false };
  if (isStudioPath(raw)) return { href: raw, external: false };
  try {
    const u = new URL(raw);
    if (u.protocol === "https:" && !u.username && !u.password) return { href: u.toString(), external: true };
  } catch {
    // not a link
  }
  return { href: null, external: false };
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
