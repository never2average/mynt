"use client";

// Builds: every coding-agent build across the user's apps, newest first; each opens in its app's
// workspace. The page itself is components/builds-view.tsx.
import { useEffect, useState } from "react";

import { BuildsView, type BuildRow } from "@/components/builds-view";
import type { ProjectItem } from "@/lib/project-types";

export default function BuildsPage() {
  const [rows, setRows] = useState<BuildRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/projects", { cache: "no-store" }).catch(() => null);
      const data = (await res?.json().catch(() => null)) as { projects?: ProjectItem[] } | null;
      if (!res?.ok || !data) setError("Your builds couldn't be loaded. Try again in a moment.");
      const all = (data?.projects ?? []).flatMap((p) =>
        p.conversations.map((c) => ({ appId: p.id, appName: p.name, id: c.id, title: c.title, status: c.status, updatedAt: c.updatedAt, metrics: c.metrics ?? null })),
      );
      setRows(all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    })();
  }, []);

  return (
    <div className="@container/main flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:gap-5 lg:p-6" data-builds-page>
        <BuildsView rows={rows} error={error} />
      </div>
    </div>
  );
}
