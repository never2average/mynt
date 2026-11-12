// What developers see of the boxes their work runs on (the build sandbox where the coding agents work, and the
// hosting VM their apps run on): command output, logs and files, capped and with secrets scrubbed.

export const BOX_OUTPUT_LIMIT = 64_000;
export const BOX_TIMEOUT_MAX = 300;

// Credentials a box may hold: Mynt's own keys and tokens (app keys, client sessions, and the tokens minted for
// each hosted agent), provider keys (GitHub, Stripe, Slack, AWS, Anthropic, webhook secrets), PEM private keys,
// passwords in URLs, and anything assigned to a name that says it's secret (NAME=value, `name: value`, JSON).
// Each pattern comes with what replaces it, so labels and quotes stay readable and only the value goes.
const MYNT_TOKEN_KINDS = ["live", "test", "agent", "bd", "explore", "desk", "review", "paudit", "predteam"];
const SECRET_NAME = String.raw`TOKEN|SECRET(?:_KEY)?|PASSWORD|PASSWD|PASSPHRASE|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTH_KEY`;
const JSON_SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:token|secret|password|passwd|passphrase|api[_-]?key|private[_-]?key|access[_-]?key|credentials?)|(?:[A-Za-z0-9.-]*[_-])?pass`;
const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g, "[redacted]"],
  [/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*$/g, "[redacted]"], // cut off before its end line
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted]"],
  [new RegExp(String.raw`\bmynt_(?:${MYNT_TOKEN_KINDS.join("|")})_[A-Za-z0-9_-]{8,}`, "g"), "[redacted]"],
  [/\bmcs_(?:live|test)_[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\bwhsec_[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g, "[redacted]"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]"],
  // scheme://user:password@host keeps the user and host.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, "$1[redacted]@"],
  // "api_key": "…" and 'password': '…'
  [new RegExp(String.raw`((["'])(?:${JSON_SECRET_NAME})\2[ \t]*:[ \t]*)(["'])(?:(?!\3)[^\\\n]|\\.){6,}\3`, "gi"), "$1$3[redacted]$3"],
  // NAME=value and `name: value`, for names that say they're secret (a URL already scrubbed above is left as is).
  [new RegExp(String.raw`\b([A-Z0-9_]*(?:${SECRET_NAME})[ \t]*[=:][ \t]*)(?!\[redacted\]@)("?)[^\s"]{6,}\2`, "gi"), "$1[redacted]"],
  // Upper-case variables ending in _KEY or _PASS (STRIPE_KEY=…, DB_PASS=…), and PASS itself.
  [/\b((?:[A-Z0-9]+_)+(?:KEY|PASS)|PASS)([ \t]*[=:][ \t]*)(?!\[redacted\]@)(["']?)[^\s"']{6,}\3/g, "$1$2[redacted]"],
];

export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  for (const [p, to] of SECRET_PATTERNS) out = out.replace(p, to);
  return out;
}

// Keeps the end of long output (where errors are), says how much was cut.
export function capOutput(text: string, limit = BOX_OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  return `[${text.length - limit} earlier characters cut]\n` + text.slice(-limit);
}

export const boxOutput = (text: string, secrets: string[] = []) => capOutput(redact(text, secrets));

// Quotes a value for a POSIX shell.
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// VS Code in the browser, for the build sandbox: a pinned code-server release, bound to localhost and reached
// only through the sandbox's token-gated URL, with a password on top.
export const CODE_SERVER_VERSION = "4.96.4";
export const EDITOR_PORT = 8443;
export const EDITOR_CONFIG = "/home/user/.config/mynt-editor.yaml";
// The password goes in a config file written over the sandbox API, never on a command line.
export const editorConfig = (password: string) => `bind-addr: 127.0.0.1:${EDITOR_PORT}\nauth: password\npassword: ${password}\ncert: false\n`;
export function editorCommand(workspace: string): string {
  const v = CODE_SERVER_VERSION;
  const dir = `$HOME/.local/code-server-${v}`;
  return [
    `set -e`,
    `chmod 600 ${EDITOR_CONFIG}`,
    `if [ ! -x ${dir}/bin/code-server ]; then mkdir -p $HOME/.local && curl -fsSL https://github.com/coder/code-server/releases/download/v${v}/code-server-${v}-linux-amd64.tar.gz | tar -xz -C $HOME/.local && mv $HOME/.local/code-server-${v}-linux-amd64 ${dir}; fi`,
    `pkill -f "code-server --config ${EDITOR_CONFIG}" || true`,
    `nohup ${dir}/bin/code-server --config ${EDITOR_CONFIG} --disable-telemetry --disable-update-check ${shellQuote(workspace)} >$HOME/.local/code-server.log 2>&1 &`,
  ].join("\n");
}

// Commands the hosting agent runs on the developer's behalf, always against one of the developer's own app
// containers; exec runs inside the container (under gVisor), never on the VM itself.
export const HOSTING_COMMANDS = ["status", "logs", "restart", "exec"] as const;
export type HostingCommandKind = (typeof HOSTING_COMMANDS)[number];
