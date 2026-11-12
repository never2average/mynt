// What developers see of the boxes their work runs on (the build sandbox where the coding agents work, and the
// hosting VM their apps run on): command output, logs and files, capped and with secrets scrubbed.

export const BOX_OUTPUT_LIMIT = 64_000;
export const BOX_TIMEOUT_MAX = 300;

// Credentials a box may hold: Mynt's own keys and tokens (app keys, client sessions, and the tokens minted for
// each hosted agent), provider keys (GitHub, Stripe, OpenAI, Google, Slack, npm, AWS, Anthropic, webhook secrets),
// JWTs, PEM and PGP private keys, passwords in URLs, Authorization headers, and anything assigned to a name that
// says it's secret (NAME=value, `name: value`, JSON). Labels, quotes and URL hosts stay readable; only the value goes.
//
// redact() runs synchronously on uncapped output, so every pattern must stay linear: no unbounded run that can fail
// and then be retried from each position inside it. Runs that can fail start only where a run begins (a lookbehind)
// or are bounded, and secret-named values are found by a scan that never re-reads text. test/builds.test.js times
// adversarial inputs against all of it.
const MYNT_TOKEN_KINDS = ["live", "test", "agent", "bd", "explore", "desk", "review", "paudit", "predteam"];
const R = "[redacted]";
const SP = String.raw`[ \t\r]*`;
const PEM_LABEL = String.raw`(?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?`;

const SECRET_PATTERNS: [RegExp, string][] = [
  // A BEGIN line followed by key content, up to its END line, or to the end of output when it was cut off.
  // A bare marker (source code that checks for one) isn't followed by key content and stays.
  [new RegExp(String.raw`-----BEGIN ${PEM_LABEL}-----\r?\n(?:\r?\n)?(?=[A-Za-z0-9+/=])(?:[\s\S]*?-----END ${PEM_LABEL}-----|[\s\S]*$)`, "g"), R],
  // Keys and tokens recognisable by their shape, in one pass.
  [
    new RegExp(
      [
        String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}\b`, // GitHub
        String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}\b`,
        String.raw`\bmynt_(?:${MYNT_TOKEN_KINDS.join("|")})_[A-Za-z0-9_-]{8,}`, // Mynt app keys and agent tokens
        String.raw`\bmcs_(?:live|test)_[A-Za-z0-9_-]{8,}`, // Mynt client sessions
        String.raw`\bwhsec_[A-Za-z0-9_-]{8,}`, // webhook secrets
        String.raw`\bsk-ant-[A-Za-z0-9_-]{8,}`, // Anthropic
        String.raw`\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{32,}`, // OpenAI
        String.raw`\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]{8,}`, // Stripe
        String.raw`\bxox[abpre]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}`, // Slack
        String.raw`\bnpm_[A-Za-z0-9]{36}\b`, // npm
        String.raw`\bAIza[0-9A-Za-z_-]{35}`, // Google
        String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`, // AWS access key ids
        String.raw`eyJ(?<![A-Za-z0-9_-]eyJ)[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}`, // JWTs
      ].join("|"),
      "g",
    ),
    R,
  ],
  // scheme://user:password@host keeps the user (which may be empty) and host.
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:)[^\s@/]+@/gi, `$1${R}@`],
  // Authorization: Bearer … (a header, curl -H, or JSON), but not prose such as "authorization: required".
  [new RegExp(String.raw`\b(authorization["']?${SP}[:=]${SP}["']?(?:(?:bearer|basic|token)[ \t]+)?)(?!(?:bearer|basic|token|required|optional|missing|invalid|denied|failed|expired|enabled|disabled|header|none|null|true|false)(?![A-Za-z0-9._~+/=-]))[A-Za-z0-9._~+/=-]{6,}`, "gi"), `$1${R}`],
];

// NAME=value, `name: value` and "name": "value": a name that says it's secret (any case; db_pass and PASS included),
// then its value: the whole quoted span (any length; an unclosed quote runs to the end of its line, leaving its \r\n)
// or an unquoted run of at least 6 characters (through any quote inside it, so abc"defghijkl" goes whole). The scan
// looks for the end of such a name (a secret word and a separator), then walks back to the name's start.
//
// Linearity: every value the scan reads is consumed (redacted or passed over as a whole), and the checks that skip a
// value look only at its first characters, or at a bounded run, before reading it. So no text is read more than a
// bounded number of times, however many names hide inside a value.
const NAME_END = new RegExp(String.raw`(token|secret|pass(?:wd|word|phrase)?|key|credentials?)["']?${SP}[=:]${SP}`, "gi");
// Names are at most 64 characters, which bounds the walk back. Longer runs are identifiers or data, not names.
const NAME_MAX = 64;
const isNameChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 45; // [A-Za-z0-9_.-]
const VALUE = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|["'][^\r\n]*|(?=\S{6})[^\s"']{1,5}["']\S*|[^\s"']{6,}/y;
const SECRET_NAME = /(?:token|secret|password|passwd|passphrase|api[_-]?key|private[_-]?key|secret[_-]?key|access[_-]?key|auth[_-]?key|credentials?)$|(?:^|[_.])pass$/i;
// Upper-case names ending in _KEY (SENDGRID_KEY=…) are secret too, except public keys.
const isSecretName = (name: string) => SECRET_NAME.test(name) || (/^[A-Z0-9_]*[A-Z0-9]_KEY$/.test(name) && !/PUB(?:LIC)?_KEY$/.test(name));
// A path given for a key or credentials file isn't the key (SSH_KEY=~/.ssh/id_ed25519), but secret, API, access, auth
// and private keys are always redacted. A path starts with ~/ or ./, or is an absolute path with a . - or _ in it
// (base64 has none of those), and holds no + or = (which base64 does).
const mayNameKeyFile = (name: string) => /(?:key|credentials?)$/i.test(name) && !/(?:secret|api|access|auth|private)[_-]?key$/i.test(name);
const KEY_FILE_PATH = /["']?(?:~\/|\.\.?\/|\/(?=[A-Za-z0-9_/]{0,256}[._-]))[A-Za-z0-9_./-]{1,256}["']?(?=[\s,;]|$)/y;

function scrubAssignments(text: string): string {
  let out = "";
  let last = 0;
  NAME_END.lastIndex = 0;
  for (let m; (m = NAME_END.exec(text)); ) {
    // An ordinary name resumes the scan right after its separator, so a value can hold an assignment (env:GITHUB_TOKEN=…).
    const at = m.index + m[0].length;
    const nameEnd = m.index + m[1].length;
    let start = m.index;
    while (start > 0 && nameEnd - start < NAME_MAX && isNameChar(text.charCodeAt(start - 1))) start--;
    if (start > 0 && isNameChar(text.charCodeAt(start - 1))) continue; // longer than a name
    const name = text.slice(start, nameEnd);
    if (!isSecretName(name)) continue;
    // Already redacted by a pattern above (a URL password, a token).
    if (text.startsWith(R, at)) {
      NAME_END.lastIndex = at + R.length;
      continue;
    }
    if (mayNameKeyFile(name)) {
      KEY_FILE_PATH.lastIndex = at;
      const path = KEY_FILE_PATH.exec(text);
      if (path) {
        NAME_END.lastIndex = at + path[0].length;
        continue;
      }
    }
    VALUE.lastIndex = at;
    const value = VALUE.exec(text)?.[0];
    if (!value) continue; // an unquoted value under 6 characters
    NAME_END.lastIndex = at + value.length;
    const q = value[0] === '"' || value[0] === "'" ? value[0] : "";
    if (q && value.length === 2 && value[1] === q) continue; // empty
    if (name === "pass" && /^\d+$/.test(value)) continue; // a test count (pass: 12); PASS=12345678 is a password
    out += text.slice(last, at) + (!q ? R : value.length > 1 && value.endsWith(q) ? `${q}${R}${q}` : `${q}${R}`);
    last = at + value.length;
  }
  return out + text.slice(last);
}

export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join(R);
  for (const [p, to] of SECRET_PATTERNS) out = out.replace(p, to);
  return scrubAssignments(out);
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
