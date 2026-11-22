"use client";
// The builder's composer controls: Ship for a session build, and a message held while a build is
// verified. (No spending cap here: Mynt applies its own to every build.) Labelled buttons and fields,
// never icon-only.
import { Rocket, X } from "lucide-react";
import { Button } from "@/components/ui/button";

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
