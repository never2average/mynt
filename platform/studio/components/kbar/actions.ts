// The Cmd+K bar's actions, from what Mynt's search finds (lib/studio-search.ts): Studio's pages, the workspace's apps
// and their tabs, the user's financial products, members and audit actions; in the platform admin, its sections, every
// workspace and regulated firm, then Studio's pages. Pure: components/kbar/index.tsx adds where each one goes.
import type { AskArea } from '@/lib/ask-answer';
import type { SearchGroup, SearchItem } from '@/lib/studio-search';

export type SearchAction = {
  id: string;
  name: string;
  section: { name: string; priority: number };
  keywords: string;
  subtitle?: string;
  parent?: string;
  /** Where it goes; a browse entry goes nowhere (it lists what's under it). */
  href?: string;
};

// Entries that only list what's under them: typing finds the members and audit actions themselves.
const BROWSE: { id: string; group: SearchGroup; name: string; subtitle: string; keywords: string }[] = [
  { id: 'members', group: 'Members', name: 'Members', subtitle: "Browse the workspace's members", keywords: 'members people team roles' },
  { id: 'audit-actions', group: 'Audit actions', name: 'Audit actions', subtitle: 'Browse the audit trail by action', keywords: 'audit trail actions history' }
];
export const BROWSE_IDS: ReadonlySet<string> = new Set(BROWSE.map((b) => b.id));

// The sections, in the order the bar lists them (a higher priority is listed first; Ask AI's is 10).
const ORDER: Record<AskArea, SearchGroup[]> = {
  studio: ['Pages', 'Apps', 'Financial products', 'Members', 'Audit actions'],
  admin: ['Platform admin', 'Workspaces', 'Regulated firms', 'Studio']
};

const after = (label: string, mark: string) => (label.includes(mark) ? label.slice(label.lastIndexOf(mark) + mark.length) : label);

/** What an item is listed under, when it's found by typing only: an app's tab under its app, a workspace or firm under its section. */
function parentOf(item: SearchItem): { parent: string; name: string } | null {
  if (item.id.startsWith('apptab:')) return { parent: `app:${item.id.slice(7, item.id.lastIndexOf(':'))}`, name: after(item.label, ': ') };
  if (item.id === 'page:/platform/firms?tab=licences') return { parent: 'page:/platform/firms', name: after(item.label, ' → ') };
  if (item.id === 'platform:/platform/firms?tab=licences') return { parent: 'platform:/platform/firms', name: after(item.label, ' → ') };
  if (item.group === 'Workspaces') return { parent: 'platform:/platform/workspaces', name: item.label };
  if (item.group === 'Regulated firms') return { parent: 'platform:/platform/firms', name: item.label };
  const browse = BROWSE.find((b) => b.group === item.group);
  return browse ? { parent: browse.id, name: item.label } : null;
}

export function searchActions(area: AskArea, items: SearchItem[]): SearchAction[] {
  const order = ORDER[area];
  const section = (group: SearchGroup) => ({ name: group, priority: Math.max(1, order.length - order.indexOf(group)) });
  const actions: SearchAction[] = [];
  const seen = new Set<string>();
  for (const b of BROWSE)
    if (items.some((i) => i.group === b.group)) {
      seen.add(b.id);
      actions.push({ id: b.id, name: b.name, section: section(b.group), keywords: b.keywords, subtitle: b.subtitle });
    }
  for (const item of items) {
    if (seen.has(item.id) || !order.includes(item.group)) continue;
    seen.add(item.id);
    const under = parentOf(item);
    actions.push({
      id: item.id,
      name: under?.name ?? item.label,
      section: section(item.group),
      keywords: item.text,
      subtitle: item.hint ?? (under ? undefined : `Go to ${item.label}`),
      ...(under ? { parent: under.parent } : {}),
      href: item.href
    });
  }
  // An item whose parent isn't listed (the app went away) is listed on its own.
  return actions.map((a) => (a.parent && !seen.has(a.parent) ? { ...a, parent: undefined } : a));
}
