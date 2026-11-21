// Slash commands in the studio's chat composers (Earn, Ask AI, an app's builder chat): typing "/"
// at the start of the input lists the chat's commands, one row each, "/command  description".
// A command either runs an action the chat already has (and clears the input) or fills the input
// with a prompt to finish. Pure: the composer's menu (components/assistant-ui/slash-command-menu.tsx)
// and the tests share it.

export type SlashCommand = {
  /** Typed after "/": lowercase letters, digits and dashes. */
  name: string;
  description: string;
  /** An action: runs, and the input is cleared. */
  run?: () => void;
  /** A prompt: replaces the input, for the user to finish and send. */
  template?: string;
  /** Shown only to these roles; every role when left out. */
  roles?: readonly string[];
};

/** The commands this user's roles may use. */
export const visibleCommands = (commands: readonly SlashCommand[], roles: readonly string[] = []): SlashCommand[] =>
  commands.filter((c) => !c.roles || c.roles.some((r) => roles.includes(r)));

/** What's typed after "/" when the input is a command being typed (no space yet); null otherwise. */
export const slashQuery = (text: string): string | null => {
  const m = /^\/(\S*)$/.exec(text);
  return m ? m[1] : null;
};

/** Commands matching what's typed: names starting with it first, then names containing it or a description word starting with it. */
export function matchCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...commands];
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const words = (s: string) => s.toLowerCase().split(/[^a-z0-9&$]+/);
  const rest = commands.filter((c) => !starts.includes(c) && (c.name.toLowerCase().includes(q) || words(c.description).some((w) => w.startsWith(q))));
  return [...starts, ...rest];
}
