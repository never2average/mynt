import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AdminView } from "@/components/admin-view";
import { adminTabOf } from "@/lib/admin";
import { isAdminSession } from "@/lib/admin-server";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const ID = /^[A-Za-z0-9-]{1,100}$/;

// The Admin area (/admin?tab=…&id=…): only for an account Mynt says is an admin (lib/admin-server.ts). Anyone else,
// signed in or not, gets the 404 page: nothing says there's an admin area here.
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!(await isAdminSession())) notFound();
  const params = await searchParams;
  const id = first(params.id);
  const tab = adminTabOf(first(params.tab));
  const shown = id && ID.test(id) ? id : null;
  // Keyed by the address: the sidebar's Admin links open their tab even while the page is already open.
  return <AdminView key={`${tab}:${shown ?? ""}`} initialTab={tab} initialId={shown} />;
}
