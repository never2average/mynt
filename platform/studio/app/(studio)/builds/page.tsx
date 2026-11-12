"use client";

// Builds: every coding-agent build across the user's apps, newest first; each opens in its app's
// workspace.
import Link from "next/link";
import { useEffect, useState } from "react";

import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ProjectItem } from "@/lib/project-types";

type Row = { appId: string; appName: string; id: string; title: string; status: string; updatedAt: string };

export default function BuildsPage() {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/projects", { cache: "no-store" }).catch(() => null);
      const data = (await res?.json().catch(() => null)) as { projects?: ProjectItem[] } | null;
      const all = (data?.projects ?? []).flatMap((p) =>
        p.conversations.map((c) => ({ appId: p.id, appName: p.name, id: c.id, title: c.title, status: c.status, updatedAt: c.updatedAt })),
      );
      setRows(all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    })();
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <SiteHeader title="Builds" />
      <div className="p-4 lg:p-6">
        {rows === null ? (
          <p className="text-sm text-muted-foreground">Loading builds…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No builds yet. <Link className="underline" href="/new">Start a new app</Link>.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Build</TableHead>
                <TableHead>App</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="max-w-md truncate font-medium">
                    <Link className="hover:underline" href={`/${encodeURIComponent(r.appId)}/${encodeURIComponent(r.id)}`}>
                      {r.title}
                    </Link>
                  </TableCell>
                  <TableCell>{r.appName}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{r.status}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.updatedAt ? new Date(r.updatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
