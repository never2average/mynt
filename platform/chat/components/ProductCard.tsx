"use client";

import { splitHeadline, type ProductCard as Card } from "@/lib/events";

export function cardLabel(card: Card): string {
  return `${card.title} · Ready`;
}

export function ProductCard({
  card,
  state,
  disabled,
  onAccept,
  onMore,
}: {
  card: Card;
  state: "idle" | "accepting" | "accepted";
  disabled: boolean;
  onAccept(): void;
  onMore(): void;
}) {
  const { headline, rest } = splitHeadline(card);
  const termsLine = rest.map((t) => `${t.label} ${t.value}`).join(" · ");
  return (
    <article className="card" aria-label={card.title}>
      <p className="card-label">{cardLabel(card)}</p>
      {headline && (
        <>
          <p className="card-amount-label">{headline.label}</p>
          <p className="card-amount">{headline.value}</p>
        </>
      )}
      <p className="card-summary">{card.summary}</p>
      {termsLine && <p className="card-terms">{termsLine}</p>}
      {card.provider && <p className="card-provider">Offered by {card.provider}</p>}
      <div className="card-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onAccept}
          disabled={disabled || state !== "idle"}
        >
          {state === "accepting" ? "Accepting…" : state === "accepted" ? "Accepted" : "Accept"}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onMore} disabled={disabled}>
          Look for more options
        </button>
      </div>
    </article>
  );
}
