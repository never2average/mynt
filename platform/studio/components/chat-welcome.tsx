"use client";

// The chat workspace's empty state, shared by the builder and Earn (components/chat-workspace-shell.tsx):
// Mynt's mark over a big centred heading, an optional line under it, example chips, and anything else the page adds
// (the builder's list of builds). A chip sends its prompt, or with `fill` only puts it in the
// composer (the builder's: a sent message starts a build, so the user sends it themselves).
import { ThreadPrimitive } from "@assistant-ui/react";
import type { ReactNode } from "react";

import { MyntMark } from "@/components/brand/mynt-logo";

export function ChatWelcome({ title, subtitle, chips = [], fill = false, children }: { title: string; subtitle?: ReactNode; chips?: readonly string[]; fill?: boolean; children?: ReactNode }) {
  return (
    <div className="aui-thread-welcome-root mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col" data-chat-welcome>
      <div className="aui-thread-welcome-center flex w-full grow flex-col items-center justify-center">
        <div className="aui-thread-welcome-message flex flex-col items-center justify-center gap-2 px-4 text-center">
          <MyntMark size={36} className="mb-2" />
          {title && <h1 className="aui-thread-welcome-message-inner animate-in text-2xl font-semibold tracking-tight duration-300 fade-in slide-in-from-bottom-2 md:text-3xl">{title}</h1>}
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {chips.length > 0 && (
          <div className="mt-6 flex flex-wrap justify-center gap-2 px-4" data-chips>
            {chips.map((c) => (
              <ThreadPrimitive.Suggestion
                key={c}
                prompt={c}
                send={!fill}
                clearComposer
                className="rounded-full border bg-background px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                data-chip={c}
              >
                {c}
              </ThreadPrimitive.Suggestion>
            ))}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
