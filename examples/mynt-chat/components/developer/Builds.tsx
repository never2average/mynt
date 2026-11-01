"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ACTIVE_BUILD,
  FINISHED_BUILD,
  activityRows,
  buildFacts,
  buildRow,
  buildRows,
  diffView,
  filesView,
  formatUsd,
  joinPath,
  matches,
  reopenState,
  runRow,
  safeUrl,
  timelineRows,
  type BuildList,
  type EventRow,
  type FilesView,
  type FileRow,
} from "@/lib/developer";
import { callDevTool, type ToolResult } from "./api";
import { RunPanel } from "./RunPanel";
import { ActionRow, DataTable, ExternalLink, MetaCard, Notice, Pre, SecretPanel, StatusPill, Tabs, Toolbar } from "./ui";

type Report = (r: ToolResult) => boolean; // true when the call worked; shows the error otherwise

const STATUS_FILTERS = ["", "active", "succeeded", "blocked", "failed", "stopped", "over_budget"] as const;

export function BuildsSection({ report, onOpen }: { report: Report; onOpen: (id: string) => void }) {
  const [list, setList] = useState<BuildList | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("");

  const load = useCallback(async () => {
    setLoading(true);
    const r = await callDevTool("list_builds");
    setLoading(false);
    if (report(r)) setList(buildRows(r.data));
  }, [report]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(
    () =>
      (list?.rows ?? []).filter(
        (b) => (status === "" ? true : status === "active" ? ACTIVE_BUILD.has(b.status) : b.status === status) && matches({ id: b.id, status: b.status, goal: b.goal, app: b.app_id }, query),
      ),
    [list, query, status],
  );

  return (
    <div className="dev-section">
      <Toolbar query={query} onQuery={setQuery} placeholder="Search builds by goal, status, id or app">
        <label className="dev-select">
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as (typeof STATUS_FILTERS)[number])}>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s === "" ? "All" : s.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-secondary dev-btn" onClick={() => void load()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </Toolbar>
      {list && list.monthSpend !== null ? (
        <p className="dev-muted">
          Spent this month: {formatUsd(list.monthSpend)}
          {list.monthlyCap !== null ? ` of ${formatUsd(list.monthlyCap)}` : ""}. Start builds from Mynt (start_build); they show up here.
        </p>
      ) : null}
      <DataTable
        columns={[
          { key: "status", label: "Status", render: (b) => <StatusPill status={b.status} /> },
          { key: "goal", label: "Goal", wide: true },
          { key: "cost", label: "Cost" },
          { key: "created", label: "Created" },
        ]}
        rows={rows}
        rowKey={(b) => b.id}
        onRowClick={(b) => onOpen(b.id)}
        rowLabel={(b) => `Open build: ${b.goal}`}
        empty={list?.rows.length ? "No builds match." : "No builds yet."}
        loading={loading && !list}
      />
    </div>
  );
}

const BUILD_TABS = [
  { id: "activity", label: "Activity" },
  { id: "timeline", label: "Timeline" },
  { id: "files", label: "Files" },
  { id: "diff", label: "Diff" },
  { id: "run", label: "Run" },
] as const;
type BuildTab = (typeof BUILD_TABS)[number]["id"];

export function BuildDetail({ buildId, report, onBack }: { buildId: string; report: Report; onBack: () => void }) {
  const [build, setBuild] = useState<unknown>(null);
  const [tab, setTab] = useState<BuildTab>("activity");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The editor's link and password: component state only, dropped on "Done" or leaving the page.
  const [editor, setEditor] = useState<{ url: string; password: string } | null>(null);
  const [steering, setSteering] = useState(false);
  const [steer, setSteer] = useState("");
  // A finished build's reopened sandbox: "opening" while reopen_sandbox says it isn't ready yet.
  const [sandbox, setSandbox] = useState<{ state: "opening" | "ready"; until: string } | null>(null);
  const [sandboxRev, setSandboxRev] = useState(0);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (poll.current) clearTimeout(poll.current);
  }, []);

  const loadBuild = useCallback(async () => {
    const r = await callDevTool("get_build", { build_id: buildId });
    if (report(r)) setBuild(r.data);
  }, [buildId, report]);

  useEffect(() => {
    void loadBuild();
  }, [loadBuild]);

  const row = build ? buildRow(build) : null;
  const facts = build ? buildFacts(build) : [];
  const status = row?.status ?? "";
  const branch = build ? String((build as { branch?: unknown }).branch ?? "") : "";
  const canReopen = FINISHED_BUILD.has(status) && Boolean(branch);

  const reopen = async () => {
    if (poll.current) clearTimeout(poll.current);
    setBusy("reopen");
    const tick = async (): Promise<void> => {
      const r = await callDevTool("reopen_sandbox", { build_id: buildId, hours: 4 });
      if (!report(r)) {
        setBusy(null);
        setSandbox(null);
        return;
      }
      const s = reopenState(r.data);
      if (s.ready) {
        setBusy(null);
        setSandbox({ state: "ready", until: s.until });
        setSandboxRev((n) => n + 1);
        setNotice(`Sandbox ready on ${branch}${s.until ? ` until ${s.until}` : ""}. Files, Diff, Run and VS Code work on it; commit and push to the branch to keep changes.`);
        return;
      }
      setSandbox({ state: "opening", until: s.until });
      poll.current = setTimeout(() => void tick(), 4000);
    };
    await tick();
  };

  const closeSandbox = async () => {
    if (!window.confirm("Close the reopened sandbox? Anything you haven't pushed to the branch is lost.")) return;
    if (poll.current) clearTimeout(poll.current);
    setBusy("close");
    const r = await callDevTool("close_sandbox", { build_id: buildId });
    setBusy(null);
    if (report(r)) {
      setSandbox(null);
      setSandboxRev((n) => n + 1);
      setNotice("Sandbox closed.");
    }
  };

  const openEditor = async () => {
    // Opened now, while the click still counts as a user gesture, so it isn't blocked as a pop-up.
    const tab = window.open("", "_blank");
    setBusy("editor");
    const r = await callDevTool("open_sandbox_editor", { build_id: buildId });
    setBusy(null);
    const data = (r.data ?? {}) as { url?: unknown; password?: unknown };
    const url = safeUrl(data.url);
    if (!report(r) || !url) {
      tab?.close();
      return;
    }
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    }
    setEditor({ url, password: typeof data.password === "string" ? data.password : "" });
  };

  const sendSteer = async (e: FormEvent) => {
    e.preventDefault();
    if (steer.trim().length < 3) return;
    setBusy("steer");
    const r = await callDevTool("steer_build", { build_id: buildId, message: steer.trim() });
    setBusy(null);
    if (report(r)) {
      setSteer("");
      setSteering(false);
      setNotice("Sent to the coding agent.");
    }
  };

  const stop = async () => {
    if (!window.confirm("Stop this build? Its sandbox is stopped and billing ends. This can't be undone.")) return;
    setBusy("stop");
    const r = await callDevTool("stop_build", { build_id: buildId });
    setBusy(null);
    if (report(r)) {
      setNotice("Build stopped.");
      void loadBuild();
    }
  };

  return (
    <div className="dev-section">
      <ActionRow>
        <button type="button" className="btn btn-secondary dev-btn" onClick={onBack}>
          Back to builds
        </button>
        <button type="button" className="btn btn-secondary dev-btn" onClick={() => void loadBuild()}>
          Refresh
        </button>
        <button type="button" className="btn btn-primary dev-btn" onClick={() => void openEditor()} disabled={busy !== null}>
          {busy === "editor" ? "Starting VS Code…" : "Open in VS Code"}
        </button>
        <button type="button" className="btn btn-secondary dev-btn" onClick={() => setSteering((s) => !s)} disabled={!ACTIVE_BUILD.has(status)}>
          Steer
        </button>
        <button type="button" className="btn btn-danger dev-btn" onClick={() => void stop()} disabled={busy !== null || !ACTIVE_BUILD.has(status)}>
          {busy === "stop" ? "Stopping…" : "Stop build"}
        </button>
        {canReopen ? (
          <>
            <button type="button" className="btn btn-secondary dev-btn" onClick={() => void reopen()} disabled={busy !== null}>
              {busy === "reopen" ? "Reopening sandbox…" : sandbox?.state === "ready" ? "Extend sandbox" : "Reopen sandbox"}
            </button>
            <button type="button" className="btn btn-danger dev-btn" onClick={() => void closeSandbox()} disabled={busy === "close" || busy === "editor"}>
              {busy === "close" ? "Closing…" : "Close sandbox"}
            </button>
          </>
        ) : null}
      </ActionRow>

      {notice ? (
        <Notice tone="ok" onDismiss={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}

      {sandbox?.state === "opening" ? <Notice tone="info">Reopening a sandbox on {branch}; this takes a minute or two. Checking every few seconds…</Notice> : null}

      {editor ? (
        <SecretPanel
          title="VS Code on the build's sandbox"
          label="Password"
          value={editor.password}
          warning="This password is shown once and isn't saved anywhere. Copy it now; anyone with it and the link can edit your sandbox."
          onDone={() => setEditor(null)}
        >
          <p>
            <ExternalLink href={editor.url}>Open VS Code in a new tab</ExternalLink> (if it didn&apos;t open already). Edits land in the agents&apos; working tree; tell them
            with Steer.
          </p>
        </SecretPanel>
      ) : null}

      {steering ? (
        <form className="dev-steer" onSubmit={sendSteer}>
          <label>
            Instruction for the coding agent
            <textarea value={steer} onChange={(e) => setSteer(e.target.value)} rows={3} maxLength={4000} placeholder="e.g. use the existing design system" />
          </label>
          <div className="dev-actions">
            <button type="submit" className="btn btn-primary dev-btn" disabled={busy !== null || steer.trim().length < 3}>
              {busy === "steer" ? "Sending…" : "Send to the agent"}
            </button>
            <button type="button" className="btn btn-secondary dev-btn" onClick={() => setSteering(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <MetaCard
        title={row?.goal ? row.goal.split("\n")[0].slice(0, 160) : "Build"}
        subtitle={buildId}
        facts={[
          ...(status ? ([["Status", <StatusPill key="s" status={status} />]] as [string, React.ReactNode][]) : []),
          ...facts.filter(([k]) => k !== "Status"),
          ...(row?.preview_url ? ([["Preview", <ExternalLink key="p" href={row.preview_url}>{row.preview_url}</ExternalLink>]] as [string, React.ReactNode][]) : []),
          ...(row?.pr_url ? ([["Pull request", <ExternalLink key="pr" href={row.pr_url}>{row.pr_url}</ExternalLink>]] as [string, React.ReactNode][]) : []),
        ]}
      />

      <Tabs tabs={BUILD_TABS} current={tab} onChange={setTab} label="Build details" />
      <div className="dev-tabpanel" role="tabpanel" key={sandboxRev}>
        {tab === "activity" ? <ActivityTab buildId={buildId} report={report} /> : null}
        {tab === "timeline" ? <EventsTable rows={build ? timelineRows(build) : []} empty={build ? "No events yet." : "Loading…"} withTime /> : null}
        {tab === "files" ? <FilesTab buildId={buildId} report={report} /> : null}
        {tab === "diff" ? <DiffTab buildId={buildId} report={report} /> : null}
        {tab === "run" ? (
          <RunPanel
            placeholder="npm test"
            hint="Runs in the app's directory in the build's sandbox. Output is capped and secrets are scrubbed; every command goes on the build's timeline."
            run={async (command) => {
              const r = await callDevTool("sandbox_run", { build_id: buildId, command });
              if (r.signedOut) report(r);
              return runRow(command, r.ok ? r.data : (r.error ?? r.data), !r.ok);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function EventsTable({ rows, empty, withTime }: { rows: EventRow[]; empty: string; withTime?: boolean }) {
  return (
    <DataTable
      columns={[
        ...(withTime ? [{ key: "at", label: "When" }] : []),
        { key: "kind", label: withTime ? "Phase" : "Type" },
        { key: "message", label: "What happened", wide: true },
      ]}
      rows={rows}
      rowKey={(_, i) => String(i)}
      empty={empty}
    />
  );
}

function ActivityTab({ buildId, report }: { buildId: string; report: Report }) {
  const [rows, setRows] = useState<EventRow[] | null>(null);
  const [phase, setPhase] = useState("");
  const [query, setQuery] = useState("");
  const load = useCallback(async () => {
    const r = await callDevTool("get_build_activity", { build_id: buildId, limit: 100 });
    if (report(r)) {
      setRows(activityRows(r.data));
      setPhase(String((r.data as { phase_message?: unknown })?.phase_message ?? ""));
    } else setRows([]);
  }, [buildId, report]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <>
      <Toolbar query={query} onQuery={setQuery} placeholder="Search activity">
        <button type="button" className="btn btn-secondary dev-btn" onClick={() => void load()}>
          Refresh activity
        </button>
      </Toolbar>
      {phase ? <p className="dev-muted">{phase}</p> : null}
      <EventsTable rows={(rows ?? []).filter((r) => matches(r, query))} empty={rows ? "No activity yet." : "Loading…"} />
    </>
  );
}

function FilesTab({ buildId, report }: { buildId: string; report: Report }) {
  const [path, setPath] = useState(".");
  const [dir, setDir] = useState(".");
  const [view, setView] = useState<FilesView | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  const open = useCallback(
    async (p: string) => {
      setLoading(true);
      const r = await callDevTool("sandbox_files", { build_id: buildId, path: p });
      setLoading(false);
      if (!r.ok && !r.data) {
        report(r);
        return;
      }
      const v = filesView(r.data, p);
      setView(v);
      setPath(p);
      if ("entries" in v) setDir(p);
      setQuery("");
    },
    [buildId, report],
  );

  useEffect(() => {
    void open(".");
  }, [open]);

  const entries = view && "entries" in view ? view.entries.filter((e) => matches(e, query)) : [];

  return (
    <>
      <Toolbar query={query} onQuery={setQuery} placeholder={`Filter ${dir === "." ? "the app folder" : dir}`}>
        <button type="button" className="btn btn-secondary dev-btn" onClick={() => void open(joinPath(dir, ".."))} disabled={dir === "." || loading}>
          Up a folder
        </button>
        <button type="button" className="btn btn-secondary dev-btn" onClick={() => void open(path)} disabled={loading}>
          Refresh files
        </button>
      </Toolbar>
      <p className="dev-muted mono">{view?.path ?? path}</p>
      {view && "error" in view ? <Notice tone="error">{view.error}</Notice> : null}
      {view && "content" in view ? (
        <>
          <ActionRow>
            <button type="button" className="btn btn-secondary dev-btn" onClick={() => void open(dir)}>
              Back to folder
            </button>
          </ActionRow>
          <Pre text={view.content} empty="(empty file)" />
        </>
      ) : (
        <DataTable<FileRow>
          columns={[
            { key: "name", label: "Name", wide: true, mono: true, render: (f) => (f.kind === "dir" ? `${f.name}/` : f.name) },
            { key: "kind", label: "Kind" },
            { key: "size", label: "Size" },
            { key: "modified", label: "Modified" },
          ]}
          rows={entries}
          rowKey={(f) => f.name}
          onRowClick={(f) => void open(joinPath(dir, f.name))}
          rowLabel={(f) => `Open ${f.name}`}
          empty={loading ? "Loading…" : "Nothing here."}
        />
      )}
    </>
  );
}

function DiffTab({ buildId, report }: { buildId: string; report: Report }) {
  const [view, setView] = useState<ReturnType<typeof diffView> | null>(null);
  const [query, setQuery] = useState("");
  const load = useCallback(async () => {
    const r = await callDevTool("sandbox_diff", { build_id: buildId });
    if (report(r)) setView(diffView(r.data));
  }, [buildId, report]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <>
      <Toolbar query={query} onQuery={setQuery} placeholder="Search changed files">
        <button type="button" className="btn btn-secondary dev-btn" onClick={() => void load()}>
          Refresh diff
        </button>
      </Toolbar>
      {view?.error ? <Notice tone="error">{view.error}</Notice> : null}
      <DataTable
        columns={[
          { key: "status", label: "Git status" },
          { key: "path", label: "File", wide: true, mono: true },
          { key: "stat", label: "Lines changed", mono: true },
        ]}
        rows={(view?.changes ?? []).filter((c) => matches(c, query))}
        rowKey={(c) => c.path}
        empty={view ? "No changes yet." : "Loading…"}
        fill={false}
      />
      {view?.diff ? <Pre text={view.diff} empty="" /> : null}
    </>
  );
}
