"use client";

import { useState, type FormEvent } from "react";
import type { RunRow } from "@/lib/developer";
import { DataTable, Pre } from "./ui";

// A command box and, below it, a table of what was run here and what came back (newest first).
// The history is this tab's state only.
export function RunPanel({ run, placeholder, hint }: { run: (command: string) => Promise<RunRow>; placeholder: string; hint: string }) {
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<RunRow[]>([]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const c = command.trim();
    if (!c || busy) return;
    setBusy(true);
    try {
      const row = await run(c);
      setRows((prev) => [row, ...prev]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dev-run">
      <form className="dev-run-form" onSubmit={submit}>
        <label className="dev-search">
          <span className="sr-only">Command</span>
          <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder={placeholder} className="mono" autoComplete="off" spellCheck={false} maxLength={4000} />
        </label>
        <button type="submit" className="btn btn-primary dev-btn" disabled={busy || !command.trim()}>
          {busy ? "Running…" : "Run command"}
        </button>
      </form>
      <p className="dev-muted">{hint}</p>
      <DataTable
        columns={[
          { key: "command", label: "Command", mono: true },
          { key: "exit", label: "Exit" },
          { key: "output", label: "Output", wide: true, render: (r) => <Pre text={r.output} empty="(no output)" /> },
          { key: "at", label: "Ran at" },
        ]}
        rows={rows}
        rowKey={(r, i) => `${rows.length - i}`}
        empty={busy ? "Running…" : "Nothing run yet."}
      />
    </div>
  );
}
