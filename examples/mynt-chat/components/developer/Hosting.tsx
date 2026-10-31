"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { appRow, buildRows, formatDate, hostingView, logRows, matches, runRow, statusRows, type AppRow, type BuildRow } from "@/lib/developer";
import { callDevTool, type ToolResult } from "./api";
import { RunPanel } from "./RunPanel";
import { ActionRow, DataTable, ExternalLink, MetaCard, Notice, Pre, SecretPanel, StatusPill, Tabs, Toolbar } from "./ui";

type Report = (r: ToolResult) => boolean;

export function HostingSection({ report, onOpen }: { report: Report; onOpen: (app: AppRow) => void }) {
  const [data, setData] = useState<ReturnType<typeof hostingView> | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  // The SSH login: component state only, dropped on "Done" or leaving the page.
  const [ssh, setSsh] = useState<{ command: string; expires: string } | null>(null);
  const [deploying, setDeploying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await callDevTool("hosting_status");
    setLoading(false);
    if (report(r)) setData(hostingView(r.data));
  }, [report]);

  useEffect(() => {
    void load();
  }, [load]);

  const requestHosting = async () => {
    setBusy("request");
    const r = await callDevTool("request_hosting");
    setBusy(null);
    if (report(r)) {
      setNotice("Your VM is being created. It registers with Mynt on its own; refresh in a minute.");
      void load();
    }
  };

  const sshLogin = async () => {
    setBusy("ssh");
    const r = await callDevTool("vm_access", { hours: 8 });
    setBusy(null);
    if (!report(r)) return;
    const d = (r.data ?? {}) as { ssh?: unknown; expires_at?: unknown };
    if (typeof d.ssh === "string") setSsh({ command: d.ssh, expires: typeof d.expires_at === "string" ? formatDate(d.expires_at) : "" });
  };

  const apps = useMemo(() => (data?.apps ?? []).filter((a) => matches(a, query)), [data, query]);
  const hasTenant = Boolean(data?.tenant);

  return (
    <div className="dev-section">
      <Toolbar query={query} onQuery={setQuery} placeholder="Search hosted apps by id, URL, status or commit">
        <button type="button" className="btn btn-secondary dev-btn" onClick={() => void load()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        {data && !hasTenant ? (
          <button type="button" className="btn btn-primary dev-btn" onClick={() => void requestHosting()} disabled={busy !== null}>
            {busy === "request" ? "Requesting…" : "Request hosting"}
          </button>
        ) : null}
        <button type="button" className="btn btn-secondary dev-btn" onClick={() => setDeploying((d) => !d)} disabled={!hasTenant}>
          Deploy an app
        </button>
        <button type="button" className="btn btn-secondary dev-btn" onClick={() => void sshLogin()} disabled={!hasTenant || busy !== null}>
          {busy === "ssh" ? "Getting a login…" : "SSH login"}
        </button>
      </Toolbar>

      {notice ? (
        <Notice tone="ok" onDismiss={() => setNotice(null)}>
          {notice}
        </Notice>
      ) : null}

      {ssh ? (
        <SecretPanel
          title="SSH login to your hosting VM"
          label="Command"
          value={ssh.command}
          warning={`This is a credential: anyone with it can log in to your VM${ssh.expires ? ` until ${ssh.expires}` : ""}. It's shown once and not saved anywhere; a new login revokes this one. Don't paste it into chats or tickets.`}
          onDone={() => setSsh(null)}
        >
          <p className="dev-muted">Paste it in a terminal, or use it as a VS Code Remote-SSH host. Your apps run as containers named mynt-app-&lt;id&gt;.</p>
        </SecretPanel>
      ) : null}

      {deploying ? (
        <DeployForm
          report={report}
          onDone={(msg) => {
            setDeploying(false);
            setNotice(msg);
            void load();
          }}
          onCancel={() => setDeploying(false)}
        />
      ) : null}

      {data ? (
        data.tenant ? (
          <MetaCard
            title="Your hosting"
            subtitle="An isolated VM that runs your apps from builds Mynt verified, reachable only through Mynt's gateway."
            facts={data.tenant.map(([k, v]) => [k, k === "Status" ? <StatusPill key="s" status={v} /> : v] as [string, ReactNode])}
          />
        ) : (
          <Notice tone="info">You have no hosting yet. Request hosting to get your own isolated VM for your apps.</Notice>
        )
      ) : null}

      <DataTable
        columns={[
          { key: "app_id", label: "App", mono: true },
          { key: "url", label: "URL", wide: true, render: (a) => (a.url ? <ExternalLink href={a.url}>{a.url}</ExternalLink> : "not served") },
          { key: "status", label: "Status", render: (a) => <StatusPill status={a.status} /> },
          { key: "commit", label: "Commit", mono: true },
          { key: "error", label: "Error" },
          { key: "updated", label: "Updated" },
        ]}
        rows={apps}
        rowKey={(a) => a.app_id}
        onRowClick={onOpen}
        rowLabel={(a) => `Open hosted app ${a.app_id}`}
        empty={data?.apps.length ? "No apps match." : "No apps hosted yet."}
        loading={loading && !data}
      />
    </div>
  );
}

function DeployForm({ report, onDone, onCancel }: { report: Report; onDone: (message: string) => void; onCancel: () => void }) {
  const [builds, setBuilds] = useState<BuildRow[]>([]);
  const [appId, setAppId] = useState("");
  const [buildId, setBuildId] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await callDevTool("list_builds", { status: "succeeded" });
      if (report(r)) setBuilds(buildRows(r.data).rows);
    })();
  }, [report]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!appId.trim() || !buildId) return;
    setBusy(true);
    const r = await callDevTool("deploy_app", { app_id: appId.trim(), build_id: buildId });
    setBusy(false);
    if (report(r)) onDone("Deploying. Your VM fetches the verified commit, builds it and starts it; refresh to follow.");
  };

  return (
    <form className="dev-steer" onSubmit={submit}>
      <label>
        Build Mynt verified
        <select
          value={buildId}
          onChange={(e) => {
            setBuildId(e.target.value);
            const b = builds.find((x) => x.id === e.target.value);
            if (b?.app_id) setAppId(b.app_id);
          }}
        >
          <option value="">{builds.length ? "Choose a build" : "No succeeded builds yet"}</option>
          {builds.map((b) => (
            <option key={b.id} value={b.id}>
              {b.goal.slice(0, 80)} ({b.created})
            </option>
          ))}
        </select>
      </label>
      <label>
        App id
        <input value={appId} onChange={(e) => setAppId(e.target.value)} className="mono" autoComplete="off" spellCheck={false} />
      </label>
      <div className="dev-actions">
        <button type="submit" className="btn btn-primary dev-btn" disabled={busy || !appId.trim() || !buildId}>
          {busy ? "Deploying…" : "Deploy"}
        </button>
        <button type="button" className="btn btn-secondary dev-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const APP_TABS = [
  { id: "logs", label: "Logs" },
  { id: "status", label: "Status" },
  { id: "run", label: "Run" },
] as const;
type AppTab = (typeof APP_TABS)[number]["id"];

export function AppDetail({ initial, report, onBack }: { initial: AppRow; report: Report; onBack: () => void }) {
  const [app, setApp] = useState<AppRow>(initial);
  const [tab, setTab] = useState<AppTab>("logs");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const appId = initial.app_id;

  const reload = useCallback(async () => {
    const r = await callDevTool("hosting_status");
    if (!report(r)) return;
    const found = ((r.data as { apps?: unknown[] })?.apps ?? []).map(appRow).find((a) => a.app_id === appId);
    if (found) setApp(found);
    else setNotice({ tone: "error", text: "This app isn't hosted any more." });
  }, [appId, report]);

  const restart = async () => {
    if (!window.confirm("Restart this app's container? It runs the same verified commit.")) return;
    setBusy("restart");
    const r = await callDevTool("restart_app", { app_id: appId });
    setBusy(null);
    if (report(r)) setNotice({ tone: "ok", text: "Restarted." });
  };

  const undeploy = async () => {
    if (!window.confirm("Stop hosting this app? Your VM removes it within 30 seconds and its URL stops answering.")) return;
    setBusy("undeploy");
    const r = await callDevTool("undeploy_app", { app_id: appId });
    setBusy(null);
    if (report(r)) {
      setNotice({ tone: "ok", text: "Undeployed. Your VM removes it on its next check." });
      void reload();
    }
  };

  return (
    <div className="dev-section">
      <ActionRow>
        <button type="button" className="btn btn-secondary dev-btn" onClick={onBack}>
          Back to hosting
        </button>
        <button type="button" className="btn btn-secondary dev-btn" onClick={() => void reload()}>
          Refresh
        </button>
        <button type="button" className="btn btn-secondary dev-btn" onClick={() => void restart()} disabled={busy !== null}>
          {busy === "restart" ? "Restarting…" : "Restart"}
        </button>
        <button type="button" className="btn btn-danger dev-btn" onClick={() => void undeploy()} disabled={busy !== null}>
          {busy === "undeploy" ? "Undeploying…" : "Undeploy"}
        </button>
      </ActionRow>

      {notice ? (
        <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Notice>
      ) : null}

      <MetaCard
        title={`App ${app.app_id}`}
        subtitle={app.repository || undefined}
        facts={(
          [
            ["Status", <StatusPill key="s" status={app.status} />],
            ["URL", app.url ? <ExternalLink key="u" href={app.url}>{app.url}</ExternalLink> : "not served"],
            ["Commit", app.commit],
            ["Build", app.build_id],
            ["Updated", app.updated],
            ["Error", app.error],
          ] as [string, ReactNode][]
        ).filter(([, v]) => v)}
      />

      <Tabs tabs={APP_TABS} current={tab} onChange={setTab} label="Hosted app details" />
      <div className="dev-tabpanel" role="tabpanel">
        {tab === "logs" ? <LogsTab appId={appId} report={report} /> : null}
        {tab === "status" ? <StatusTab appId={appId} report={report} /> : null}
        {tab === "run" ? (
          <RunPanel
            placeholder="wget -qO- localhost:8080/healthz"
            hint="Runs inside the app's container (under gVisor, read-only apart from /tmp), never on the VM itself. Output is capped and secrets are scrubbed; every command is audited."
            run={async (command) => {
              const r = await callDevTool("app_run", { app_id: appId, command });
              if (r.signedOut) report(r);
              return runRow(command, r.ok ? r.data : (r.error ?? r.data), !r.ok);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

const TAILS = [100, 200, 500, 1000, 2000];

function LogsTab({ appId, report }: { appId: string; report: Report }) {
  const [output, setOutput] = useState<string | null>(null);
  const [tail, setTail] = useState(200);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    const r = await callDevTool("app_logs", { app_id: appId, tail });
    setLoading(false);
    if (report(r)) setOutput(String((r.data as { output?: unknown })?.output ?? ""));
  }, [appId, tail, report]);
  useEffect(() => {
    void load();
  }, [load]);
  const rows = useMemo(() => logRows(output ?? "").filter((l) => matches(l, query)), [output, query]);
  return (
    <>
      <Toolbar query={query} onQuery={setQuery} placeholder="Search log lines">
        <label className="dev-select">
          <span>Lines</span>
          <select value={tail} onChange={(e) => setTail(Number(e.target.value))}>
            {TAILS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-secondary dev-btn" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "Refresh logs"}
        </button>
      </Toolbar>
      <DataTable
        columns={[
          { key: "at", label: "Time (UTC)" },
          { key: "line", label: "Line", wide: true, mono: true },
        ]}
        rows={rows}
        rowKey={(_, i) => String(i)}
        empty={output === null ? "Loading…" : "No log lines."}
      />
    </>
  );
}

function StatusTab({ appId, report }: { appId: string; report: Report }) {
  const [output, setOutput] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await callDevTool("app_status", { app_id: appId });
    if (report(r)) setOutput(String((r.data as { output?: unknown })?.output ?? ""));
  }, [appId, report]);
  useEffect(() => {
    void load();
  }, [load]);
  const rows = statusRows(output ?? "").map(([k, v]) => ({ k, v }));
  return (
    <>
      <ActionRow>
        <button type="button" className="btn btn-secondary dev-btn" onClick={() => void load()}>
          Refresh status
        </button>
      </ActionRow>
      <DataTable
        columns={[
          { key: "k", label: "Field" },
          { key: "v", label: "Value", wide: true, mono: true },
        ]}
        rows={rows}
        rowKey={(r, i) => `${r.k}-${i}`}
        empty={output === null ? "Loading…" : "Your VM returned no status."}
      />
      {output && rows.every((r) => !r.k) ? <Pre text={output} empty="" /> : null}
    </>
  );
}
