"use client";

import type { RequestProposal } from "@/lib/events";

const LINES: Record<string, string> = {
  credit: "Credit",
  securitization: "Securitisation",
  payments: "Payments",
  account_operations: "Deposits and accounts",
  custody_settlement: "Custody and settlement",
  wealth: "Savings and investing",
  insurance: "Insurance",
  guarantees_trade: "Guarantees and trade finance",
  exchange: "Currency and trading",
  derivatives: "Hedging",
  information: "Credit reports and data",
};

function details(request: RequestProposal): string {
  const parts: string[] = [];
  if (request.product_line) parts.push(LINES[request.product_line] ?? request.product_line);
  if (request.amount) parts.push(`₹${request.amount.toLocaleString("en-IN")}`);
  if (request.tenor_days) parts.push(`${request.tenor_days} days`);
  return parts.join(" · ");
}

// A product request the assistant proposed. Nothing reaches Mynt until the user taps
// "Send request"; this card shows exactly what would be sent.
export function RequestCard({
  request,
  state,
  disabled,
  onSend,
  onDecline,
}: {
  request: RequestProposal;
  state: "idle" | "sending" | "sent";
  disabled: boolean;
  onSend(): void;
  onDecline(): void;
}) {
  const line = details(request);
  return (
    <article className="card" aria-label="Product request">
      <p className="card-label">Request for Mynt&apos;s product teams</p>
      <p className="request-need">{request.need}</p>
      {line && <p className="request-details">{line}</p>}
      {request.context && <p className="request-details">{request.context}</p>}
      <p className="request-privacy">Product teams see this text, not your name or number.</p>
      <div className="card-actions">
        <button type="button" className="btn btn-primary" onClick={onSend} disabled={disabled || state !== "idle"}>
          {state === "sending" ? "Sending…" : state === "sent" ? "Sent" : "Send request"}
        </button>
        {state !== "sent" && (
          <button type="button" className="btn btn-secondary" onClick={onDecline} disabled={disabled || state !== "idle"}>
            Not now
          </button>
        )}
      </div>
    </article>
  );
}
