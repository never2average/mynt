// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { Session } from "@/lib/session-store";
import { ADMIN_TOOLS, parseAdminCall, parseStudioCall } from "@/lib/studio-tools";

// Platform admin → Platform settings: four tabs (Key vault, Operational settings, E-signature, Risk grading), each
// ONE table filling the page under one toolbar, with no cards or stacked sections; every change a labelled button
// opening a sheet. The key vault's flows end to end (the sheet → the route → Mynt's tool): Set key, Replace key and
// Remove key; a key's value is in the request once and never in the page's markup or any answer; keys the server's
// environment sets are read-only rows. Every key here is an obvious fake.

const fake = {
  session: undefined as Session | undefined,
  sameOrigin: true,
  tools: [] as { name: string }[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  refuse: null as string | null,
  reply: {} as Record<string, unknown>,
};
vi.mock("@/lib/session", () => ({ currentSession: async () => fake.session, fromOwnOrigin: () => fake.sameOrigin, setSessionCookie: () => undefined }));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      if (fake.refuse) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: fake.refuse }) }] };
      return { content: [{ type: "text", text: JSON.stringify(fake.reply[name] ?? { ok: true }) }] };
    },
    close: async () => undefined,
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }), useSearchParams: () => new URLSearchParams("") }));

const keysRoute = await import("@/app/api/admin/keys/route");
const settingsRoute = await import("@/app/api/admin/settings/route");
const esignRoute = await import("@/app/api/admin/esign/route");
const gradingRoute = await import("@/app/api/admin/risk-grading/route");
const { SettingsTab, SettingsTabs } = await import("@/components/admin-settings");
const { KeyVaultView, KEY_VAULT_HEAD } = await import("@/components/admin-key-vault");
const { OperationalSettingsView, SETTINGS_HEAD } = await import("@/components/admin-operational-settings");
const { EsignSettingsView, EsignSettingsPanel } = await import("@/components/esign-settings-view");
const { RiskGradingView } = await import("@/components/admin-risk-grading");
const lib = await import("@/lib/platform-settings");
const { esignStatusFrom } = await import("@/lib/esign-settings");
const { gradingFrom } = await import("@/lib/risk-grading");

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FAKE_KEY = "sk-ant-FAKE-not-a-real-key-0001";
const FAKE_HOOK = "whsec_FAKEfakeFAKEfake0001";
const key = (over: Record<string, unknown>) => ({
  type: "X",
  label: "X",
  purpose: "What it's for",
  used_by: "Something",
  validation: "One line",
  multiline: false,
  source: "none",
  source_label: "Not set",
  server_only: false,
  set_at: null,
  set_by: null,
  fingerprint: null,
  validated_at: null,
  last_used_at: null,
  needs_restart: true,
  takes_effect: "After a restart",
  vault_key: null,
  readable: null,
  times_replaced: 0,
  note: null,
  ...over,
});
// list_platform_keys' reply, as Mynt sends it: one key of each kind of row.
const KEYS = {
  vault_ready: true,
  keys: [
    key({ type: "ANTHROPIC_API_KEY", label: "Model provider key (Anthropic API)", used_by: "Every agent, through the agent proxy", validation: "Starts with sk-ant-" }),
    key({ type: "CLERK_WEBHOOK_SECRET", label: "Sign-in provider webhook secret (Clerk)", used_by: "Workspace sync", source: "vault", source_label: "Key vault", set_at: "2026-11-25T09:30:00.000Z", set_by: "Ada", fingerprint: "0a1b2c3d", needs_restart: false, takes_effect: "At once", times_replaced: 1 }),
    key({ type: "FREESTYLE_API_KEY", label: "Hosting and sandbox provider key (Freestyle)", used_by: "Hosting and agent sandboxes", source: "environment", source_label: "Server environment", note: "Set on the server; overrides the vault" }),
    key({ type: "GITHUB_APP_PRIVATE_KEY", label: "GitHub App private key", used_by: "Builds, the product desk and hosting", multiline: true, validation: "A private key in PEM form" }),
    key({ type: "DATABASE_URL", label: "Database connection string", used_by: "Everything", source: "environment", source_label: "Server environment", server_only: true, validation: null, note: "Set on the server only. Mynt needs it to open the database the key vault is kept in" }),
    key({ type: "MYNT_VAULT_KEY", label: "Vault key", used_by: "The key vault and every sealed value", server_only: true, validation: null, note: "Set on the server only. It's the key the vault is sealed with, so it can't be kept inside it" }),
  ],
};
const setting = (over: Record<string, unknown>) => ({ key: "X", value: "1", default: "1", source: "default", source_label: "Mynt's default", kind: "usd", description: "", used_by: "Coding-agent builds", validation: "A number from 0.5 to 500", options: null, overridden_by_environment: false, stored_value: null, set_at: null, set_by: null, needs_restart: false, ...over });
const SETTINGS = {
  settings: [
    setting({ key: "BUILD_CAP_USD", value: "10", default: "10", description: "Spend cap for one coding-agent build" }),
    setting({ key: "BUILD_MONTHLY_CAP_USD", value: "250", default: "100", source: "stored", description: "Each developer's build budget per calendar month", set_at: "2026-11-24T08:00:00.000Z", set_by: "Ada", stored_value: "250", validation: "A number from 1 to 50000" }),
    setting({ key: "BUILD_AUDIT", value: "none", default: "none", description: "The security audit run on each build: maxwell, or none", options: ["none", "maxwell"], validation: "One of: none, maxwell" }),
    setting({ key: "EXPLORE_CAP_USD", value: "35", default: "20", source: "environment", description: "Spend cap for one algorithm exploration", overridden_by_environment: true }),
  ],
};
const ESIGN = {
  providers: ["signwell"],
  provider: "signwell",
  configured: true,
  vault_ready: true,
  key: { set: true, source: "studio", set_at: "2026-11-23T10:00:00.000Z", set_by: "Ada" },
  webhook: { registered: true, source: "studio", registered_at: "2026-11-23T10:00:01.000Z", callback_url: "https://mynt.example/esign/webhook", can_register: true },
  test_mode: { on: true, source: "studio" },
  last_event_at: null,
};
const BANDS = [
  { level: "low", from: 1, to: 4 },
  { level: "medium", from: 5, to: 9 },
  { level: "high", from: 10, to: 14 },
  { level: "critical", from: 15, to: 25 },
];
const row4 = (v: string[]) => ({ none: v[0], weak: v[1], partial: v[2], strong: v[3] });
const GRADING = {
  version: 1,
  grading: {
    levels: { low: "Low", medium: "Medium", high: "High", critical: "Critical" },
    inherent_bands: BANDS,
    residual_bands: BANDS,
    residual_method: "reduce",
    reduce: { none: 0, weak: 0.25, partial: 0.5, strong: 0.75 },
    matrix: { low: row4(["low", "low", "low", "low"]), medium: row4(["medium", "medium", "low", "low"]), high: row4(["high", "high", "medium", "low"]), critical: row4(["critical", "critical", "high", "medium"]) },
  },
  method_in_words: "Residual = inherent × (1 − the control's reduction).",
  history: [{ version: 1, grading: null, note: "Mynt's defaults", restored_from: null, residuals_changed: null, created_by: null, created_at: "2026-11-10T10:00:00.000Z" }],
};

const session = (roles: string[]) => ({ id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles, rolesAt: Date.now() }) as Session;
const post = (route: { POST: (r: Request) => Promise<Response> }, path: string, body: unknown) => route.POST(new Request(`http://studio.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
// The page's own requests, answered by the real routes: what a sheet posts goes through the route to Mynt's tool.
const ROUTES: Record<string, { GET: () => Promise<Response>; POST: (r: Request) => Promise<Response> }> = { "/api/admin/keys": keysRoute, "/api/admin/settings": settingsRoute, "/api/admin/esign": esignRoute, "/api/admin/risk-grading": gradingRoute };
const sent: { url: string; body: string }[] = [];
const throughRoutes = (async (url: string, init?: RequestInit) => {
  const route = ROUTES[url];
  if (!route) return new Response("{}", { status: 404 });
  if (init?.method === "POST") {
    sent.push({ url, body: String(init.body) });
    return route.POST(new Request(`http://studio.test${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: init.body as string }));
  }
  return route.GET();
}) as unknown as typeof fetch;

const click = async (sel: string) => act(async () => void fireEvent.click(document.querySelector(sel)!));
const submit = (sel: string) => act(async () => void fireEvent.submit(document.querySelector(sel)!));
const change = (sel: string, value: string) => fireEvent.change(document.querySelector(sel)!, { target: { value } });
const escape = () => act(async () => void fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
const head = (root: string) => [...document.querySelectorAll(`${root} thead th`)].map((th) => th.textContent);
const cells = (root: string) => [...document.querySelectorAll(`${root} tbody tr`)].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent!.trim().replace(/\s+/g, " ")));
const rowOf = (type: string) => document.querySelector(`[data-key-vault] tr[data-row="${type}"]`)!;
const vault = () => lib.keyVaultFrom(KEYS)!;

// One toolbar row over ONE table that fills the area, with a sticky head and a pager; nothing card-like around it.
function expectOneTable(root: string) {
  const el = document.querySelector(root)!;
  expect(el, root).not.toBeNull();
  expect(el.querySelectorAll("table"), `${root}: one table`).toHaveLength(1);
  expect(el.querySelectorAll("[data-toolbar]"), `${root}: one toolbar`).toHaveLength(1);
  expect(el.querySelectorAll("section, form, dl, h2, h3, [data-metadata-card], [data-slot=card], [data-admin-list] [data-admin-list]"), `${root}: no card sections or forms on the page`).toHaveLength(0);
  expect(el.className).toMatch(/\bmin-h-0\b/);
  expect(el.className).toMatch(/\bflex-1\b/);
  const list = el.querySelector("[data-admin-list]")!;
  expect(list.className).toMatch(/\bmin-h-0\b.*\bflex-1\b/);
  expect(el.querySelector("[data-table-view]")!.className).toMatch(/\bflex-1\b.*\boverflow-auto\b/);
  expect(el.querySelector("thead")!.className).toContain("sticky");
  expect(el.querySelectorAll("[data-pager]")).toHaveLength(1);
  // No icon-only buttons.
  for (const b of el.querySelectorAll("button")) expect(b.textContent!.trim(), `${root}: every button is labelled`).not.toBe("");
}

beforeEach(() => {
  fake.session = session(["admin"]);
  fake.sameOrigin = true;
  fake.tools = Object.keys(ADMIN_TOOLS).map((name) => ({ name }));
  fake.calls = [];
  fake.refuse = null;
  fake.reply = { list_platform_keys: KEYS, get_platform_settings: SETTINGS, get_esign_settings: ESIGN, get_risk_grading: GRADING };
  sent.length = 0;
});

describe("the page", () => {
  it("has four tabs, Key vault first, each named in the address", () => {
    render(<SettingsTabs tab="keys" onTab={() => undefined} />);
    expect([...document.querySelectorAll("[data-settings-tab]")].map((t) => [t.getAttribute("data-settings-tab"), t.textContent, t.getAttribute("aria-selected")])).toEqual([
      ["keys", "Key vault", "true"],
      ["operational", "Operational settings", "false"],
      ["esign", "E-signature", "false"],
      ["risk-grading", "Risk grading", "false"],
    ]);
    expect(lib.SETTINGS_TABS.map(lib.settingsHref)).toEqual(["/platform/settings?tab=keys", "/platform/settings?tab=operational", "/platform/settings?tab=esign", "/platform/settings?tab=risk-grading"]);
    expect([lib.settingsTabOf("esign"), lib.settingsTabOf(null), lib.settingsTabOf("nonsense")]).toEqual(["esign", "keys", "keys"]);
  });

  it("each tab is exactly one table under one toolbar, filling the page: no cards, no stacked sections, no forms beside it", () => {
    render(<KeyVaultView vault={vault()} />);
    expectOneTable("[data-key-vault]");
    cleanup();
    render(<OperationalSettingsView settings={lib.settingsFrom(SETTINGS)!} />);
    expectOneTable("[data-operational-settings]");
    cleanup();
    render(<EsignSettingsView status={esignStatusFrom(ESIGN)!} onAction={() => undefined} />);
    expectOneTable("[data-esign-settings]");
    cleanup();
    render(<RiskGradingView data={gradingFrom(GRADING)!} />);
    expectOneTable("[data-risk-grading]");
  });

  it("opens each tab from the real routes: one table on screen at a time, and the tab's own data only", async () => {
    vi.stubGlobal("fetch", throughRoutes);
    for (const [tab, root, tool] of [
      ["keys", "[data-key-vault]", "list_platform_keys"],
      ["operational", "[data-operational-settings]", "get_platform_settings"],
      ["esign", "[data-esign-settings]", "get_esign_settings"],
      ["risk-grading", "[data-risk-grading]", "get_risk_grading"],
    ] as const) {
      fake.calls = [];
      render(<SettingsTab tab={tab} />);
      await waitFor(() => expect(document.querySelector(root)).not.toBeNull());
      expect(document.querySelectorAll("[data-admin-settings] table"), tab).toHaveLength(1);
      expect(document.querySelectorAll("[data-admin-settings] [data-settings-tab]")).toHaveLength(4);
      expect(document.querySelector("[data-admin-settings]")!.getAttribute("data-view")).toBe(tab);
      expectOneTable(root);
      expect(fake.calls.map((c) => c.name)).toEqual([tool]);
      cleanup();
    }
  });
});

describe("Key vault", () => {
  it("one row per key: what it is, who uses it, where it comes from, who set it and when, its fingerprint, when a change takes effect", () => {
    render(<KeyVaultView vault={vault()} />);
    expect(head("[data-key-vault]")).toEqual([...KEY_VAULT_HEAD]);
    expect(head("[data-key-vault]")).toEqual(["Key", "Used by", "Source", "Set on", "Set by", "Fingerprint", "Takes effect", "Action"]);
    expect(cells("[data-key-vault]")).toEqual([
      ["Model provider key (Anthropic API)ANTHROPIC_API_KEYWhat it's for", "Every agent, through the agent proxy", "Not set", "Never", "Nobody", "None", "After a restart", "Set key"],
      ["Sign-in provider webhook secret (Clerk)CLERK_WEBHOOK_SECRETWhat it's for", "Workspace sync", "Key vault", "2026-11-25 09:30", "Ada", "0a1b2c3d", "At once", "Replace key Remove key"],
      ["Hosting and sandbox provider key (Freestyle)FREESTYLE_API_KEYWhat it's for", "Hosting and agent sandboxes", "Server environment", "On the server", "Whoever runs the server", "None", "After a restart", "Set on the server; overrides the vault"],
      ["GitHub App private keyGITHUB_APP_PRIVATE_KEYWhat it's for", "Builds, the product desk and hosting", "Not set", "Never", "Nobody", "None", "After a restart", "Set key"],
      ["Database connection stringDATABASE_URLWhat it's for", "Everything", "Server environment", "On the server", "Whoever runs the server", "None", "After a restart (set on the server)", "Set on the server only. Mynt needs it to open the database the key vault is kept in"],
      ["Vault keyMYNT_VAULT_KEYWhat it's for", "The key vault and every sealed value", "Not set", "Never", "Nobody", "None", "After a restart (set on the server)", "Set on the server only. It's the key the vault is sealed with, so it can't be kept inside it"],
    ]);
    // The toolbar: search, Filters and Export CSV; no Import (a key is typed in once, never loaded from a file).
    expect([...document.querySelectorAll("[data-key-vault] [data-toolbar] button")].map((b) => b.textContent!.trim())).toEqual(["Filters", "Export CSV"]);
    expect(document.querySelector("[data-key-vault] [data-import]")).toBeNull();
    // No on/off switch anywhere: a key is there or it's removed.
    expect(document.querySelectorAll('[data-key-vault] input[type="checkbox"], [data-key-vault] [role="switch"]')).toHaveLength(0);
  });

  it("a key the server's environment sets, and the keys that only live on the server, are read-only rows that say so", () => {
    render(<KeyVaultView vault={vault()} />);
    for (const type of ["FREESTYLE_API_KEY", "DATABASE_URL", "MYNT_VAULT_KEY"]) {
      expect(rowOf(type).querySelectorAll("button"), type).toHaveLength(0);
      expect(rowOf(type).querySelector("[data-key-read-only]"), type).not.toBeNull();
    }
    expect(rowOf("FREESTYLE_API_KEY").querySelector("[data-key-read-only]")!.textContent).toBe("Set on the server; overrides the vault");
    expect(lib.keyActions(vault().keys[2])).toEqual({ set: null, remove: false, readOnly: "Set on the server; overrides the vault" });
    expect(lib.keyActions(vault().keys[0])).toEqual({ set: "Set key", remove: false, readOnly: null });
    expect(lib.keyActions(vault().keys[1])).toEqual({ set: "Replace key", remove: true, readOnly: null });
    // Without a vault key on the server, nothing can be set from here, and the page says why.
    cleanup();
    render(<KeyVaultView vault={lib.keyVaultFrom({ ...KEYS, vault_ready: false })!} />);
    expect((document.querySelector('[data-set-key="ANTHROPIC_API_KEY"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector("[data-list-note]")!.textContent).toContain("can't seal keys yet");
  });

  it("search and Filters narrow the one table; the export has what the table shows and no column for a value", () => {
    render(<KeyVaultView vault={vault()} />);
    change('[data-key-vault] input[aria-label="Search keys by name, type or what uses them"]', "clerk");
    expect(cells("[data-key-vault]").map((r) => r[2])).toEqual(["Key vault"]);
    change('[data-key-vault] input[aria-label="Search keys by name, type or what uses them"]', "nothing-matches");
    expect(cells("[data-key-vault]")).toEqual([["No key matches."]]);
    expect(lib.KEY_CSV_HEAD).toEqual(["Key", "Type", "Used by", "Source", "Set on", "Set by", "Fingerprint", "Takes effect"]);
    expect(lib.keyCsvRow(vault().keys[1])).toEqual(["Sign-in provider webhook secret (Clerk)", "CLERK_WEBHOOK_SECRET", "Workspace sync", "Key vault", "2026-11-25 09:30", "Ada", "0a1b2c3d", "At once"]);
  });

  it("Set key: a sheet with one password field, sent once through the route to set_platform_key, and gone from the page", async () => {
    let changed = 0;
    render(<KeyVaultView vault={vault()} fetcher={throughRoutes} onChanged={() => (changed += 1)} />);
    expect(document.querySelector('[data-admin-sheet="set-key"]')).toBeNull();
    await click('[data-set-key="ANTHROPIC_API_KEY"]');
    const sheet = document.querySelector('[data-admin-sheet="set-key"]')!;
    expect(sheet.textContent).toContain("Set key");
    expect(sheet.textContent).toContain("After the server restarts");
    expect(sheet.textContent).toContain("Starts with sk-ant-");
    const input = document.querySelector("[data-key-input]") as HTMLInputElement;
    expect([input.type, input.getAttribute("autocomplete")]).toEqual(["password", "new-password"]);
    expect(document.querySelectorAll('[data-admin-sheet="set-key"] input')).toHaveLength(1);
    expect((document.querySelector('[data-key-submit="set"]') as HTMLButtonElement).disabled).toBe(true);
    fake.reply.set_platform_key = { ok: true, type: "ANTHROPIC_API_KEY", needs_restart: true, in_effect: false, message: "Model provider key (Anthropic API) is kept in the vault. It takes effect after the server restarts.", key: KEYS.keys[0] };
    change("[data-key-input]", FAKE_KEY);
    await submit('[data-key-form="ANTHROPIC_API_KEY"]');
    await waitFor(() => expect(document.querySelector("[data-sheet-result]")).not.toBeNull());
    // Sent once, to the route, and from there to Mynt's tool: nowhere else.
    expect(sent).toEqual([{ url: "/api/admin/keys", body: JSON.stringify({ action: "set", type: "ANTHROPIC_API_KEY", value: FAKE_KEY }) }]);
    expect(fake.calls).toEqual([{ name: "set_platform_key", args: { type: "ANTHROPIC_API_KEY", value: FAKE_KEY } }]);
    expect(document.querySelector("[data-sheet-result]")!.textContent).toBe("Model provider key (Anthropic API) is kept in the vault. It takes effect after the server restarts.");
    // The field is gone, and the value is nowhere in the page.
    expect(document.querySelector("[data-key-input]")).toBeNull();
    expect(document.documentElement.outerHTML).not.toContain(FAKE_KEY);
    expect([...document.querySelectorAll("input, textarea")].some((i) => (i as HTMLInputElement).value.includes("FAKE"))).toBe(false);
    await escape();
    expect(changed).toBe(1);
  });

  it("Replace key says the old key is destroyed; a multi-line key gets a masked box, never a plain one", async () => {
    render(<KeyVaultView vault={vault()} fetcher={throughRoutes} opening={{ set: "CLERK_WEBHOOK_SECRET" }} />);
    const sheet = document.querySelector('[data-admin-sheet="set-key"]')!;
    expect(sheet.textContent).toContain("Replace key");
    expect(sheet.textContent).toContain("the old key is retired and its value destroyed");
    expect(sheet.textContent).toContain("At once: the next use reads the new key.");
    change("[data-key-input]", FAKE_HOOK);
    await submit('[data-key-form="CLERK_WEBHOOK_SECRET"]');
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(fake.calls[0]).toEqual({ name: "set_platform_key", args: { type: "CLERK_WEBHOOK_SECRET", value: FAKE_HOOK } });
    expect(document.documentElement.outerHTML).not.toContain(FAKE_HOOK);
    cleanup();
    render(<KeyVaultView vault={vault()} opening={{ set: "GITHUB_APP_PRIVATE_KEY" }} />);
    const box = document.querySelector("[data-key-input]") as HTMLTextAreaElement;
    expect(box.tagName).toBe("TEXTAREA");
    expect(box.hasAttribute("data-key-masked")).toBe(true);
    expect(box.className).toContain("[-webkit-text-security:disc]");
  });

  it("a key Mynt refuses: its words, without the key, and the field already emptied", async () => {
    fake.refuse = "Model provider key (Anthropic API): expected a key starting with sk-ant-. Nothing was kept";
    render(<KeyVaultView vault={vault()} fetcher={throughRoutes} opening={{ set: "ANTHROPIC_API_KEY" }} />);
    change("[data-key-input]", "fake-wrong-shape-000001");
    await submit('[data-key-form="ANTHROPIC_API_KEY"]');
    await waitFor(() => expect(document.querySelector("[data-sheet-error]")).not.toBeNull());
    expect(document.querySelector("[data-sheet-error]")!.textContent).toBe("Model provider key (Anthropic API): expected a key starting with sk-ant-. Nothing was kept");
    expect((document.querySelector("[data-key-input]") as HTMLInputElement).value).toBe("");
    expect(document.documentElement.outerHTML).not.toContain("fake-wrong-shape-000001");
  });

  it("Remove key: the key's type typed out, then through the route to remove_platform_key", async () => {
    render(<KeyVaultView vault={vault()} fetcher={throughRoutes} />);
    await click('[data-remove-key="CLERK_WEBHOOK_SECRET"]');
    const sheet = document.querySelector('[data-admin-sheet="remove-key"]')!;
    expect(sheet.textContent).toContain("its value destroyed");
    expect(sheet.textContent).toContain("What uses it stops at once.");
    const go = () => document.querySelector('[data-key-submit="remove"]') as HTMLButtonElement;
    expect(go().disabled).toBe(true);
    change("[data-remove-key-confirm]", "clerk_webhook_secret");
    expect(go().disabled).toBe(true);
    await submit('[data-remove-key-form="CLERK_WEBHOOK_SECRET"]');
    expect(fake.calls).toEqual([]);
    change("[data-remove-key-confirm]", "CLERK_WEBHOOK_SECRET");
    expect(go().disabled).toBe(false);
    expect(go().textContent).toBe("Remove key");
    fake.reply.remove_platform_key = { ok: true, message: "Sign-in provider webhook secret (Clerk) is removed from the vault and its value destroyed." };
    await submit('[data-remove-key-form="CLERK_WEBHOOK_SECRET"]');
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(fake.calls[0]).toEqual({ name: "remove_platform_key", args: { type: "CLERK_WEBHOOK_SECRET", confirm: true } });
    await waitFor(() => expect(document.querySelector("[data-sheet-result]")!.textContent).toBe("Sign-in provider webhook secret (Clerk) is removed from the vault and its value destroyed."));
  });
});

describe("the key vault's route", () => {
  it("never answers with a value: not from a reply that carried one, not in a refusal, and with no-store on everything", async () => {
    // Even if a reply did carry a value, the page's rows have no field for it.
    fake.reply.list_platform_keys = { ...KEYS, keys: [{ ...KEYS.keys[1], value: FAKE_HOOK, sealed: "cs1:local:secret:FAKE", fingerprint: FAKE_HOOK }] };
    const got = await keysRoute.GET();
    expect(got.headers.get("cache-control")).toBe("no-store");
    const text = await got.text();
    expect(text).not.toContain(FAKE_HOOK);
    expect(text).not.toContain("cs1:");
    expect(JSON.parse(text).vault.keys[0].fingerprint).toBeNull();
    expect(Object.keys(JSON.parse(text).vault.keys[0]).sort()).toEqual(["fingerprint", "label", "lastUsedAt", "multiline", "needsRestart", "note", "purpose", "serverOnly", "setAt", "setBy", "source", "timesReplaced", "type", "usedBy", "validatedAt", "validation"]);

    // A reply that echoed the value: only Mynt's sentence goes back.
    fake.reply.set_platform_key = { ok: true, message: "Kept.", value: FAKE_KEY, key: { value: FAKE_KEY } };
    const set = await post(keysRoute, "/api/admin/keys", { action: "set", type: "ANTHROPIC_API_KEY", value: FAKE_KEY });
    expect(set.status).toBe(200);
    expect(set.headers.get("cache-control")).toBe("no-store");
    expect(await set.json()).toEqual({ ok: true, message: "Kept." });

    fake.refuse = "The model provider refused that key";
    const refused = await post(keysRoute, "/api/admin/keys", { action: "set", type: "ANTHROPIC_API_KEY", value: FAKE_KEY });
    expect(refused.status).toBe(422);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(await refused.text()).not.toContain(FAKE_KEY);
    fake.refuse = null;

    // A body the route doesn't take is refused in fixed words, never quoting what was sent.
    const bad = await post(keysRoute, "/api/admin/keys", { action: "set", type: "not a type", value: FAKE_KEY });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain(FAKE_KEY);
  });

  it("Mynt admins only, own origin, strict bodies; Remove needs the type typed out", async () => {
    const set = { action: "set", type: "ANTHROPIC_API_KEY", value: FAKE_KEY };
    const remove = { action: "remove", type: "ANTHROPIC_API_KEY", confirm: "ANTHROPIC_API_KEY" };
    for (const roles of [["developer"], ["license_provider", "vendor"], ["developer", "innovator", "liquidity_provider"]]) {
      fake.session = session(roles);
      for (const r of [await keysRoute.GET(), await post(keysRoute, "/api/admin/keys", set), await post(keysRoute, "/api/admin/keys", remove)]) expect(r.status).toBe(404);
    }
    expect(fake.calls).toEqual([]);
    fake.session = undefined;
    expect((await keysRoute.GET()).status).toBe(401);
    expect((await post(keysRoute, "/api/admin/keys", set)).status).toBe(401);
    fake.session = session(["admin"]);
    fake.sameOrigin = false;
    expect((await post(keysRoute, "/api/admin/keys", set)).status).toBe(403);
    expect((await post(keysRoute, "/api/admin/keys", remove)).status).toBe(403);
    fake.sameOrigin = true;
    for (const bad of [{}, { action: "set", type: "ANTHROPIC_API_KEY" }, { ...set, value: "short" }, { ...set, extra: 1 }, { ...set, type: "lower_case" }, { action: "remove", type: "ANTHROPIC_API_KEY" }, { ...remove, confirm: "yes" }, { ...remove, confirm: true }, { action: "enable", type: "ANTHROPIC_API_KEY" }, { action: "reveal", type: "ANTHROPIC_API_KEY" }])
      expect((await post(keysRoute, "/api/admin/keys", bad)).status, JSON.stringify(bad)).toBe(400);
    expect(fake.calls).toEqual([]);
    expect((await post(keysRoute, "/api/admin/keys", remove)).status).toBe(200);
    expect(fake.calls).toEqual([{ name: "remove_platform_key", args: { type: "ANTHROPIC_API_KEY", confirm: true } }]);
    // An older Mynt without the vault says so.
    fake.tools = [{ name: "ops_status" }];
    expect(await (await keysRoute.GET()).json()).toEqual({ supported: false });
    expect((await post(keysRoute, "/api/admin/keys", set)).status).toBe(422);
  });

  it("the allow-list: admins' tools only, strict, and there is no tool that reads a key back", () => {
    expect(parseAdminCall("list_platform_keys", {})).toHaveProperty("tool");
    expect(parseAdminCall("list_platform_keys", { include_values: true })).toHaveProperty("error");
    expect(parseAdminCall("set_platform_key", { type: "ANTHROPIC_API_KEY", value: FAKE_KEY })).toHaveProperty("tool");
    expect(parseAdminCall("set_platform_key", { type: "ANTHROPIC_API_KEY", value: FAKE_KEY, note: "x" })).toHaveProperty("error");
    expect(parseAdminCall("remove_platform_key", { type: "ANTHROPIC_API_KEY" })).toHaveProperty("error");
    expect(parseAdminCall("set_platform_setting", { key: "BUILD_CAP_USD", value: "20" })).toHaveProperty("tool");
    expect(parseAdminCall("set_platform_setting", { key: "BUILD_CAP_USD", value: null })).toHaveProperty("tool");
    expect(Object.keys(ADMIN_TOOLS).filter((t) => /platform_key/.test(t)).sort()).toEqual(["list_platform_keys", "remove_platform_key", "set_platform_key"]);
    // The chat, Ask AI and every other page can't reach them.
    for (const t of ["list_platform_keys", "set_platform_key", "remove_platform_key", "set_platform_setting"]) expect(parseStudioCall(t, {})).toHaveProperty("error");
  });
});

describe("Operational settings", () => {
  it("one row per setting: its value, default, where it comes from and what it's for; a setting the server sets is read-only", () => {
    render(<OperationalSettingsView settings={lib.settingsFrom(SETTINGS)!} />);
    expect(head("[data-operational-settings]")).toEqual([...SETTINGS_HEAD]);
    expect(head("[data-operational-settings]")).toEqual(["Setting", "Value", "Default", "Source", "Description", "Action"]);
    expect(cells("[data-operational-settings]")).toEqual([
      ["BUILD_CAP_USD", "10", "10", "Mynt's default", "Spend cap for one coding-agent buildUsed by: Coding-agent builds", "Change setting"],
      ["BUILD_MONTHLY_CAP_USD", "250", "100", "Set in Mynt by Ada on 2026-11-24 08:00", "Each developer's build budget per calendar monthUsed by: Coding-agent builds", "Change setting"],
      ["BUILD_AUDIT", "none", "none", "Mynt's default", "The security audit run on each build: maxwell, or noneUsed by: Coding-agent builds", "Change setting"],
      ["EXPLORE_CAP_USD", "35", "20", "Server environment", "Spend cap for one algorithm explorationUsed by: Coding-agent builds", "Set on the server; overrides what's set in Mynt"],
    ]);
    expect(document.querySelector('[data-operational-settings] tr[data-row="EXPLORE_CAP_USD"] button')).toBeNull();
    expect([...document.querySelectorAll("[data-operational-settings] [data-toolbar] button")].map((b) => b.textContent!.trim())).toEqual(["Filters", "Export CSV"]);
    expect(document.querySelector("[data-list-note]")).toBeNull(); // no description under the toolbar
    expect(lib.settingCsvRow(lib.settingsFrom(SETTINGS)![1])).toEqual(["BUILD_MONTHLY_CAP_USD", "250", "100", "Set in Mynt", "Each developer's build budget per calendar month", "Coding-agent builds", "A number from 1 to 50000"]);
    // An older Mynt that can't change them: the same table, without Change setting.
    cleanup();
    render(<OperationalSettingsView settings={lib.settingsFrom(SETTINGS)!} editable={false} />);
    expect(document.querySelectorAll("[data-change-setting]")).toHaveLength(0);
  });

  it("Change setting: a sheet with how the value is checked and what changes, then through the route to set_platform_setting", async () => {
    let changed = 0;
    render(<OperationalSettingsView settings={lib.settingsFrom(SETTINGS)!} fetcher={throughRoutes} onChanged={() => (changed += 1)} />);
    await click('[data-change-setting="BUILD_CAP_USD"]');
    const sheet = document.querySelector('[data-admin-sheet="change-setting"]')!;
    expect(sheet.textContent).toContain("A number from 0.5 to 500");
    expect(sheet.textContent).toContain("No restart is needed");
    expect(document.querySelector("[data-setting-change]")!.textContent).toBe("Nothing changes yet.");
    expect((document.querySelector('[data-setting-submit="set"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[data-setting-submit="reset"]')).toBeNull();
    change("[data-setting-input]", "25");
    expect(document.querySelector("[data-setting-change]")!.textContent).toBe("BUILD_CAP_USD changes from 10 to 25.");
    fake.reply.set_platform_setting = { ok: true, message: "BUILD_CAP_USD is now 25. It applies from the next use." };
    await submit('[data-setting-form="BUILD_CAP_USD"]');
    await waitFor(() => expect(document.querySelector("[data-sheet-result]")).not.toBeNull());
    expect(sent).toEqual([{ url: "/api/admin/settings", body: JSON.stringify({ key: "BUILD_CAP_USD", value: "25" }) }]);
    expect(fake.calls).toEqual([{ name: "set_platform_setting", args: { key: "BUILD_CAP_USD", value: "25" } }]);
    expect(document.querySelector("[data-sheet-result]")!.textContent).toBe("BUILD_CAP_USD is now 25. It applies from the next use.");
    await escape();
    expect(changed).toBe(1);
  });

  it("a setting with fixed choices is a list; one set in Mynt can go back to the default; Mynt's refusal is shown in its words", async () => {
    render(<OperationalSettingsView settings={lib.settingsFrom(SETTINGS)!} fetcher={throughRoutes} opening="BUILD_AUDIT" />);
    const select = document.querySelector("[data-setting-input]") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect([...select.options].map((o) => o.value)).toEqual(["none", "maxwell"]);
    cleanup();
    render(<OperationalSettingsView settings={lib.settingsFrom(SETTINGS)!} fetcher={throughRoutes} opening="BUILD_MONTHLY_CAP_USD" />);
    expect(document.querySelector('[data-setting-submit="reset"]')!.textContent).toBe("Reset to Mynt's default (100)");
    await click('[data-setting-submit="reset"]');
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(fake.calls[0]).toEqual({ name: "set_platform_setting", args: { key: "BUILD_MONTHLY_CAP_USD", value: null } });
    cleanup();
    fake.calls = [];
    fake.refuse = "BUILD_CAP_USD takes a number from 0.5 to 500";
    render(<OperationalSettingsView settings={lib.settingsFrom(SETTINGS)!} fetcher={throughRoutes} opening="BUILD_CAP_USD" />);
    change("[data-setting-input]", "9000");
    await submit('[data-setting-form="BUILD_CAP_USD"]');
    await waitFor(() => expect(document.querySelector("[data-sheet-error]")).not.toBeNull());
    expect(document.querySelector("[data-sheet-error]")!.textContent).toBe("BUILD_CAP_USD takes a number from 0.5 to 500");
  });

  it("the route: admins only, own origin, strict; an older Mynt lists the settings without Change setting", async () => {
    const body = { key: "BUILD_CAP_USD", value: "25" };
    const got = await settingsRoute.GET();
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(await got.json()).toMatchObject({ editable: true, settings: [{ key: "BUILD_CAP_USD", value: "10", source: "default", validation: "A number from 0.5 to 500" }, { source: "stored", setBy: "Ada" }, { options: ["none", "maxwell"] }, { source: "environment" }] });
    fake.session = session(["developer", "license_provider"]);
    for (const r of [await settingsRoute.GET(), await post(settingsRoute, "/api/admin/settings", body)]) expect(r.status).toBe(404);
    fake.session = session(["admin"]);
    fake.sameOrigin = false;
    expect((await post(settingsRoute, "/api/admin/settings", body)).status).toBe(403);
    fake.sameOrigin = true;
    for (const bad of [{}, { key: "BUILD_CAP_USD" }, { ...body, extra: 1 }, { key: "lower", value: "1" }, { key: "BUILD_CAP_USD", value: 25 }, { key: "BUILD_CAP_USD", value: "" }]) expect((await post(settingsRoute, "/api/admin/settings", bad)).status, JSON.stringify(bad)).toBe(400);
    expect(fake.calls.filter((c) => c.name === "set_platform_setting")).toEqual([]);
    fake.tools = [{ name: "get_platform_settings" }];
    expect(await (await settingsRoute.GET()).json()).toMatchObject({ editable: false });
    expect((await post(settingsRoute, "/api/admin/settings", body)).status).toBe(422);
  });
});

describe("E-signature", () => {
  it("its status is rows of the one table: Setting, Value, Action; each change a labelled button", () => {
    render(<EsignSettingsView status={esignStatusFrom(ESIGN)!} onAction={() => undefined} />);
    expect(head("[data-esign-settings]")).toEqual(["Setting", "Value", "Action"]);
    expect(cells("[data-esign-settings]")).toEqual([
      ["Service", "On, with SignWell", "Follows the API key"],
      ["API key", "Key set on 2026-11-23 10:00 by Ada", "Replace key Remove key"],
      ["Mode", "Test mode: documents are free and not legally binding. Use it to try the whole flow.", "Change mode"],
      ["Webhook", "Registered on 2026-11-23 10:00The service sends its events to https://mynt.example/esign/webhook", "Re-register webhook"],
      ["Last event received", "Never", "Recorded by Mynt"],
    ]);
    // Nothing is edited on the page itself: no field, no switch, until a sheet opens.
    expect(document.querySelectorAll('[data-esign-settings] input:not([aria-label="Search the e-signature settings"]), [data-esign-settings] select, [data-esign-settings] textarea')).toHaveLength(0);
  });

  it("Set key here or in the Key vault both work: this sheet's password field goes through the route to set_esign_api_key, once", async () => {
    vi.stubGlobal("fetch", throughRoutes);
    fake.reply.set_esign_api_key = { ok: true, webhook: { registered: true, reused: false }, settings: ESIGN };
    render(<EsignSettingsPanel fetcher={throughRoutes} />);
    await waitFor(() => expect(document.querySelector("[data-esign-settings]")).not.toBeNull());
    await click("[data-esign-set-key]");
    const input = document.querySelector("[data-esign-key-input]") as HTMLInputElement;
    expect(input.type).toBe("password");
    change("[data-esign-key-input]", "sw-fake-key-0123456789");
    await submit("[data-esign-key-form]");
    await waitFor(() => expect(document.querySelector("[data-sheet-result]")).not.toBeNull());
    expect(fake.calls.find((c) => c.name === "set_esign_api_key")?.args).toEqual({ provider: "signwell", api_key: "sw-fake-key-0123456789" });
    expect(document.querySelector("[data-sheet-result]")!.textContent).toBe("Key checked and saved. The webhook is registered.");
    expect(document.documentElement.outerHTML).not.toContain("sw-fake-key-0123456789");
    // The Key vault's own Set key reaches the same key through set_platform_key (core routes it to the same check).
    expect(lib.keyActions(lib.keyVaultFrom({ keys: [key({ type: "SIGNWELL_API_KEY", source: "vault" })] })!.keys[0]).set).toBe("Replace key");
  });

  it("Change mode, Re-register webhook and Remove key (typed to confirm) are sheets that post one action each", async () => {
    const actions: unknown[] = [];
    const view = (sheet: "mode" | "webhook" | "remove") => render(<EsignSettingsView status={esignStatusFrom(ESIGN)!} onAction={(a) => actions.push(a)} sheet={sheet} />);
    view("mode");
    expect((document.querySelector("[data-esign-save-mode]") as HTMLButtonElement).disabled).toBe(true);
    await click("[data-esign-test-mode]");
    expect(document.querySelector('[data-admin-sheet="esign-mode"]')!.textContent).toContain("legally binding and count towards");
    expect(document.querySelector("[data-esign-save-mode]")!.textContent).toBe("Switch to live");
    await submit("[data-esign-mode-form]");
    cleanup();
    view("webhook");
    await click("[data-esign-register-confirm]");
    cleanup();
    view("remove");
    expect((document.querySelector("[data-esign-remove-confirm]") as HTMLButtonElement).disabled).toBe(true);
    await submit("[data-esign-confirm-remove]");
    change("[data-esign-remove-typed]", "remove");
    await submit("[data-esign-confirm-remove]");
    expect(actions).toEqual([{ action: "test_mode", test_mode: false }, { action: "register_webhook" }, { action: "remove_key" }]);
  });

  it("what the server's environment sets is read-only here too", () => {
    render(<EsignSettingsView status={esignStatusFrom({ ...ESIGN, key: { set: true, source: "environment" }, test_mode: { on: false, source: "environment" } })!} onAction={() => undefined} />);
    const rows = cells("[data-esign-settings]");
    expect(rows[1]).toEqual(["API key", "Key set in the server's environment (it takes precedence)", "Set on the server; overrides the vault"]);
    expect(rows[2]).toEqual(["Mode", "Live: documents are legally binding and count towards the e-signature service's billing.", "Set on the server (ESIGN_TEST_MODE)"]);
    expect(document.querySelector("[data-esign-set-key]")).toBeNull();
    expect(document.querySelector("[data-esign-remove-key]")).toBeNull();
    expect(document.querySelector("[data-esign-change-mode]")).toBeNull();
  });
});
