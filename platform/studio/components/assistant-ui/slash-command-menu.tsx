"use client";

// The composer's slash-command menu (lib/slash-commands.ts): when the input starts with "/", a
// popover above the composer lists the chat's commands matching what's typed, one row each: the
// command in mono, then its description on the same line. Up/Down move, Enter or Tab chooses, Esc
// closes, a click chooses. The composer's "/" button opens the same menu.
import { useAui, useAuiState } from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";

import { Command, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { matchCommands, slashQuery, type SlashCommand } from "@/lib/slash-commands";

export type SlashMenu = {
  open: boolean;
  items: SlashCommand[];
  active: number;
  setActive: (i: number) => void;
  choose: (c: SlashCommand) => void;
  dismiss: () => void;
  /** The "/" button: an empty input gets "/" (typing then filters); otherwise every command shows. */
  openMenu: () => void;
  /** The input's key handler, ahead of the composer's: while the menu is open, Enter chooses instead of sending. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
};

const focusEnd = (input: HTMLTextAreaElement | null) => {
  if (!input) return;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
};

export function useSlashMenu(commands: readonly SlashCommand[], inputRef: RefObject<HTMLTextAreaElement | null>): SlashMenu {
  const aui = useAui();
  const text = useAuiState((s) => (s.composer.isEditing ? s.composer.text : ""));
  // The text the menu was closed on (Esc, a click outside); it opens again once the text changes.
  const [dismissed, setDismissed] = useState<string | null>(null);
  // The text the "/" button opened the menu on, when that wasn't a command being typed.
  const [forced, setForced] = useState<string | null>(null);
  const typed = slashQuery(text);
  const query = typed ?? (forced !== null && forced === text ? "" : null);
  const items = useMemo(() => (query === null ? [] : matchCommands(commands, query)), [commands, query]);
  const open = query !== null && items.length > 0 && dismissed !== text;
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [query]);

  const setText = useCallback((t: string) => aui.composer().setText(t), [aui]);
  const choose = useCallback(
    (c: SlashCommand) => {
      setDismissed(null);
      setForced(null);
      if (c.template !== undefined) {
        setText(c.template);
        // After the input shows the template: the cursor at its end, to finish it.
        setTimeout(() => focusEnd(inputRef.current), 0);
        return;
      }
      setText("");
      c.run?.();
    },
    [setText, inputRef],
  );
  const dismiss = useCallback(() => setDismissed(text), [text]);
  const openMenu = useCallback(() => {
    setDismissed(null);
    if (!text) setText("/");
    else if (slashQuery(text) === null) setForced(text);
    setTimeout(() => focusEnd(inputRef.current), 0);
  }, [text, setText, inputRef]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || e.nativeEvent.isComposing) return;
    const n = items.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n));
    } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      const c = items[Math.min(active, n - 1)];
      if (c) choose(c);
    } else if (e.key === "Escape") {
      e.preventDefault();
      dismiss();
    }
  };

  return { open, items, active, setActive, choose, dismiss, openMenu, onKeyDown };
}

/** The popover, anchored to `children` (the composer's box) and opening above it. */
export function SlashCommandPopover({ menu, children }: { menu: SlashMenu; children: ReactNode }) {
  const { open, items, active, setActive, choose, dismiss } = menu;
  return (
    <Popover open={open} onOpenChange={(o) => !o && dismiss()}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        // Focus stays in the composer: the keys there move the selection.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        className="w-(--radix-popover-trigger-width) max-w-(--thread-max-width) p-1"
        data-slash-menu
      >
        <Command
          shouldFilter={false}
          value={items[active]?.name ?? ""}
          onValueChange={(v) => {
            const i = items.findIndex((c) => c.name === v);
            if (i >= 0) setActive(i);
          }}
          className="bg-transparent"
          label="Commands"
        >
          <CommandList className="max-h-64">
            {items.map((c) => (
              <CommandItem key={c.name} value={c.name} onSelect={() => choose(c)} className="gap-3" data-slash-command={c.name}>
                <span className="shrink-0 font-mono text-sm" data-slash-name>
                  /{c.name}
                </span>{" "}
                <span className="min-w-0 truncate text-muted-foreground" data-slash-description>
                  {c.description}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
