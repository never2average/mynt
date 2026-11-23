// The user's threads, for the Build page's Recent row, its View all list and the sidebar: every app they
// have (its build conversations, from /api/projects) and every financial product they're working on, both
// the product chats they had on the Build page and the products they created (list_my_products, through
// /api/products). One list, newest first, each labelled App or Financial product.
//
// Product chats are kept per signed-in user on Mynt's server (lib/chat-sessions.ts, through
// app/api/threads), as Earn keeps its conversations: the same chats in every browser they sign in from.
// Only the user reads their own.
//
// Pure, so the page, the sidebar and the tests share it.
import type { ThreadSummary } from "./chat-sessions";
import { productStageOf, STAGE_STATUS, type ProductStatus } from "./products";
import type { Stage } from "./workspaces";

export type ThreadKind = "app" | "product";
export const THREAD_KIND_LABELS: Record<ThreadKind, string> = { app: "App", product: "Financial product" };
export type ThreadFilter = "all" | ThreadKind;
export const THREAD_FILTERS: { id: ThreadFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "app", label: "Apps" },
  { id: "product", label: "Financial products" },
];

// An app's stage, as one item's status (the sidebar's folder is "Ideas"; one app is an Idea).
export const APP_STATUS: Record<Stage, string> = { production: "Production", staging: "Staging", idea: "Idea" };
export const CHAT_STATUS = { open: "Chat", created: "Created" } as const;

// "app": one of the user's apps; "chat": a product chat of theirs; "product": a product they created.
export type ThreadSource = "app" | "chat" | "product";
export type StudioThread = {
  key: string; // `${source}:${id}`, unique across the list
  kind: ThreadKind;
  source: ThreadSource;
  id: string;
  name: string;
  updatedAt: string | null; // null: Mynt didn't say when
  status: string;
  href: string;
};

// What the list is made from.
export type AppThreadSource = { id: string; name: string; stage: Stage; lastActivityAt?: string | null };
// A product's stage is its status, as an app's is (Idea, Staging, Production).
export type MyProduct = { id: string; name: string; status: ProductStatus; stage?: Stage; updatedAt: string | null };

// ---- product chats ----

// A product chat as the list has it (lib/chat-sessions.ts): its metadata's product_ids are the products
// its drafts became.
export type ProductChatRecord = Pick<ThreadSummary, "id" | "title" | "updatedAt" | "metadata">;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const chatCreated = (c: Pick<ThreadSummary, "metadata">) => Array.isArray(c.metadata.product_ids) && c.metadata.product_ids.length > 0;

// ---- the list ----

export const appHref = (id: string) => `/${encodeURIComponent(id)}`;
export const chatHref = (id: string) => `/new?thread=${encodeURIComponent(id)}`;
export const productHref = (id: string) => `/new?product=${encodeURIComponent(id)}`;

// Newest first; those with no time after, by name.
export function byUpdate(a: StudioThread, b: StudioThread): number {
  if (a.updatedAt && b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name);
  if (a.updatedAt) return -1;
  if (b.updatedAt) return 1;
  return a.name.localeCompare(b.name);
}

export function mergeThreads(apps: readonly AppThreadSource[] | null | undefined, chats: readonly ProductChatRecord[] | null | undefined, products: readonly MyProduct[] | null | undefined): StudioThread[] {
  const out: StudioThread[] = [];
  for (const a of apps ?? [])
    out.push({ key: `app:${a.id}`, kind: "app", source: "app", id: a.id, name: a.name, updatedAt: a.lastActivityAt || null, status: APP_STATUS[a.stage], href: appHref(a.id) });
  for (const c of chats ?? [])
    out.push({ key: `chat:${c.id}`, kind: "product", source: "chat", id: c.id, name: c.title, updatedAt: c.updatedAt, status: chatCreated(c) ? CHAT_STATUS.created : CHAT_STATUS.open, href: chatHref(c.id) });
  for (const p of products ?? [])
    out.push({ key: `product:${p.id}`, kind: "product", source: "product", id: p.id, name: p.name, updatedAt: p.updatedAt, status: STAGE_STATUS[p.stage ?? productStageOf(p)], href: productHref(p.id) });
  return out.sort(byUpdate);
}

// The threads of a kind whose name or status has every word of the query, in the order given.
export function filterThreads(threads: readonly StudioThread[], query: string, filter: ThreadFilter = "all"): StudioThread[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return threads.filter((t) => (filter === "all" || t.kind === filter) && words.every((w) => `${t.name} ${t.status} ${THREAD_KIND_LABELS[t.kind]}`.toLowerCase().includes(w)));
}

// "just now", "5 min ago", "3 h ago", "2 days ago", then the date; "—" when it isn't known.
export function relativeTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const s = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const days = Math.floor(s / 86400);
  if (days < 7) return days === 1 ? "yesterday" : `${days} days ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

// ---- telling the page and the sidebar ----

// A product chat saved (the sidebar reads the user's chats again) or, with products, a product
// created or published (it asks Mynt for the user's products again too).
export const THREADS_UPDATED = "mynt:threads-updated";
export type ThreadsUpdatedDetail = { products?: boolean };
// A financial-product thread picked in the sidebar while the Build page is open: it opens it in place.
export const OPEN_THREAD = "mynt:open-thread";
export type OpenThreadDetail = { thread?: string; product?: string };

export function announceThreads(detail: ThreadsUpdatedDetail = {}) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<ThreadsUpdatedDetail>(THREADS_UPDATED, { detail }));
}
export function openThreadInPlace(detail: OpenThreadDetail) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<OpenThreadDetail>(OPEN_THREAD, { detail }));
}

// ?thread= or ?product= on the Build page's address.
export function openFromSearch(search: string): OpenThreadDetail | null {
  const q = new URLSearchParams(search);
  const thread = q.get("thread")?.trim();
  const product = q.get("product")?.trim();
  if (thread) return { thread };
  if (product) return { product };
  return null;
}

// list_my_products' reply: the user's own products, with when each last changed when Mynt says.
export function myProductsFrom(reply: unknown): MyProduct[] {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return (Array.isArray(reply) ? reply : []).filter((p): p is Record<string, unknown> => isObj(p) && typeof p.id === "string" && p.id !== "").map((p) => ({
    id: str(p.id),
    name: str(p.name) || str(p.id),
    status: p.status === "draft" || p.status === "unpublished" ? p.status : "published",
    stage: productStageOf(p),
    updatedAt: str(p.updated_at) || str(p.updatedAt) || str(p.published_at) || str(p.created_at) || null,
  }));
}
