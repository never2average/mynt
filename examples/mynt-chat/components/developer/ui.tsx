"use client";

import { useState, type ReactNode } from "react";

// Shared pieces of the developer console: the search + actions row, full-height tables, the
// metadata card, tabs, and the one-time secret panel.

export function Toolbar({ query, onQuery, placeholder, children }: { query: string; onQuery: (q: string) => void; placeholder: string; children?: ReactNode }) {
  return (
    <div className="dev-toolbar">
      <label className="dev-search">
        <span className="sr-only">{placeholder}</span>
        <input type="search" value={query} onChange={(e) => onQuery(e.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false} />
      </label>
      {children ? <div className="dev-actions">{children}</div> : null}
    </div>
  );
}

export function ActionRow({ children }: { children: ReactNode }) {
  return <div className="dev-actions dev-actions-row">{children}</div>;
}

export interface Column<T> {
  key: string;
  label: string;
  render?: (row: T) => ReactNode;
  wide?: boolean; // gets the spare width (goal, message, output)
  mono?: boolean;
}

export function DataTable<T extends object>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowLabel,
  empty,
  loading,
  fill = true,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  rowLabel?: (row: T) => string;
  empty: string;
  loading?: boolean;
  fill?: boolean;
}) {
  return (
    <div className={`dev-table-wrap${fill ? " fill" : ""}`}>
      <table className="dev-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.wide ? "wide" : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr className="dev-empty">
              <td colSpan={columns.length}>{loading ? "Loading…" : empty}</td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr
                key={rowKey(row, i)}
                className={onRowClick ? "clickable" : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                aria-label={onRowClick && rowLabel ? rowLabel(row) : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
              >
                {columns.map((c) => (
                  <td key={c.key} data-label={c.label} className={[c.wide ? "wide" : "", c.mono ? "mono" : ""].join(" ").trim() || undefined}>
                    {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? "")}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function MetaCard({ title, subtitle, facts, children }: { title: string; subtitle?: string; facts: [string, ReactNode][]; children?: ReactNode }) {
  return (
    <section className="dev-meta" aria-label={title}>
      <div className="dev-meta-head">
        <h2>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {facts.length ? (
        <dl>
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {children}
    </section>
  );
}

export function Tabs<T extends string>({ tabs, current, onChange, label }: { tabs: readonly { id: T; label: string }[]; current: T; onChange: (id: T) => void; label: string }) {
  return (
    <div className="dev-tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={current === t.id} className={current === t.id ? "active" : undefined} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone = ["succeeded", "running"].includes(status)
    ? "ok"
    : ["failed", "blocked", "over_budget", "suspended", "stopped"].includes(status)
      ? "bad"
      : status
        ? "busy"
        : "";
  return <span className={`dev-pill ${tone}`}>{status ? status.replace(/_/g, " ") : "unknown"}</span>;
}

export function Notice({ tone, children, onDismiss }: { tone: "ok" | "error" | "info"; children: ReactNode; onDismiss?: () => void }) {
  return (
    <div className={`dev-notice ${tone}`} role={tone === "error" ? "alert" : "status"}>
      <div>{children}</div>
      {onDismiss ? (
        <button type="button" className="btn btn-secondary dev-btn" onClick={onDismiss}>
          Dismiss
        </button>
      ) : null}
    </div>
  );
}

// A credential shown once. It lives only in the parent's React state: "Done" drops it, and so
// does leaving the page. It is never logged, stored or put in a URL.
export function SecretPanel({ title, label, value, warning, children, onDone }: { title: string; label: string; value: string; warning: string; children?: ReactNode; onDone: () => void }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <section className="dev-secret" aria-label={title}>
      <h3>{title}</h3>
      <p className="dev-secret-warn">{warning}</p>
      {children}
      <label className="dev-secret-label">
        {label}
        <textarea readOnly value={value} rows={value.length > 60 ? 3 : 1} onFocus={(e) => e.currentTarget.select()} className="mono" autoComplete="off" spellCheck={false} />
      </label>
      <div className="dev-actions">
        <button type="button" className="btn btn-primary dev-btn" onClick={copy}>
          {copied === "copied" ? "Copied" : `Copy ${label.toLowerCase()}`}
        </button>
        <button type="button" className="btn btn-secondary dev-btn" onClick={onDone}>
          Done, hide it
        </button>
      </div>
      {copied === "failed" ? <p className="dev-muted">Couldn&apos;t copy; select the text and copy it yourself.</p> : null}
    </section>
  );
}

export function Pre({ text, empty }: { text: string; empty: string }) {
  return <pre className="dev-pre">{text || empty}</pre>;
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
