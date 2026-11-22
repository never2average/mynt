"use client";
// The builder's composer controls: the cap for the next build (also on New app), Ship for a
// session build, and a message held while a build is verified. Labelled buttons and fields,
// never icon-only.
import { useEffect, useState } from "react";
import { Rocket, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { capChoice, clampCap, type BuildBudget, type CapChoice } from "@/lib/build-cap";

export type BudgetReply = { budget: BuildBudget | null; session?: boolean };

/**
 * What a new build's cap may be, read from the studio (null until read, while not `enabled`, or
 * where Mynt doesn't say). `appId` counts its workspace's budget too; read again when `refreshKey` changes.
 */
export function useCapChoice(appId: string | null, refreshKey: unknown = 0, enabled = true): CapChoice | null {
  const [choice, setChoice] = useState<CapChoice | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const url = `/api/builds/budget${appId ? `?appId=${encodeURIComponent(appId)}` : ""}`;
    fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<BudgetReply>) : null))
      .then((data) => {
        if (live) setChoice(data?.budget ? capChoice(data.budget, { session: data.session === true }) : null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [appId, refreshKey, enabled]);
  return choice;
}

/**
 * The cap for the next build: "Cap $" and the amount, from the smallest Mynt accepts up to the
 * usual cap or what's left this month, whichever is less. Starts at the most it may be.
 */
export function CapField({ choice, value, onChange }: { choice: CapChoice; value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(value.toFixed(2));
  useEffect(() => setText(value.toFixed(2)), [value]);
  if (choice.blocked) return null;
  return (
    <label className="flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs text-muted-foreground" title={`Up to US$${choice.maxUsd.toFixed(2)}: the usual cap, or what's left of this month's build budget`}>
      Cap $
      <input
        type="number"
        inputMode="decimal"
        step="0.01"
        min={choice.minUsd}
        max={choice.maxUsd}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const v = clampCap(text, choice) ?? value;
          setText(v.toFixed(2));
          onChange(v);
        }}
        aria-label="Spending cap for this build, in US dollars"
        className="w-16 bg-transparent text-foreground tabular-nums outline-none"
        data-cap-field
      />
    </label>
  );
}

/** Ship: ends the session build; the agent ships the work and Mynt verifies it. */
export function ShipButton({ onShip, busy }: { onShip: () => void; busy: boolean }) {
  return (
    <Button type="button" size="sm" variant="outline" className="h-7 rounded-full" onClick={onShip} disabled={busy} data-ship-button>
      <Rocket className="size-3.5" />
      Ship
    </Button>
  );
}

/** A message held while the app's build is shipping or being verified, with a way to drop it. */
export function HeldMessage({ text, onRemove }: { text: string; onRemove: () => void }) {
  return (
    <span className="flex items-center justify-center gap-2" data-held-message>
      <span className="min-w-0 truncate">
        Queued — sent when verification finishes: <span className="text-foreground">“{text.length > 80 ? `${text.slice(0, 79)}…` : text}”</span>
      </span>
      <Button type="button" size="sm" variant="ghost" className="h-6 px-2" onClick={onRemove}>
        <X className="size-3" />
        Remove
      </Button>
    </span>
  );
}
