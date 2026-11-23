// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@/lib/session-store";
import { esignStatusFrom, keyLine, webhookLine } from "@/lib/esign-settings";

// Settings → E-signature (admins): what the section shows (never a key or a webhook id), the route behind it (same
// origin, signed in, admins only, strict actions, the key passed to Mynt once and never echoed), and the frame
// origins the studio learns from Mynt for the signing sheet and its Content-Security-Policy.

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

const route = await import("@/app/api/esign/route");
const { EsignSettingsView } = await import("@/components/esign-settings-view");
const frame = await import("@/lib/esign-frame");

const KEY = "sw-fake-key-0123456789";
const STATUS = {
  providers: ["signwell"],
  provider: "signwell",
  configured: true,
  vault_ready: true,
  key: { set: true, source: "studio", set_at: "2026-11-23T10:00:00.000Z", set_by: "Ada" },
  webhook: { registered: true, source: "studio", registered_at: "2026-11-23T10:00:01.000Z", callback_url: "https://mynt.example/esign/webhook", can_register: true },
  test_mode: { on: true, source: "studio" },
  last_event_at: null,
};
const session = (roles: string[]) => ({ id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles, rolesAt: Date.now() }) as Session;
const post = (body: unknown) => route.POST(new Request("http://studio.test/api/esign", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

beforeEach(() => {
  fake.session = session(["admin"]);
  fake.sameOrigin = true;
  fake.tools = ["get_esign_settings", "set_esign_api_key", "register_esign_webhook", "remove_esign_api_key", "set_esign_test_mode"].map((name) => ({ name }));
  fake.calls = [];
  fake.refuse = null;
  fake.reply = { get_esign_settings: STATUS };
  delete process.env.MYNT_MCP_URL;
  delete process.env.ESIGN_FRAME_SRC;
  frame.resetEsignFrameOrigins();
});

describe("the section", () => {
  it("status in words, never a key; the actions labelled; what each mode means", () => {
    const s = esignStatusFrom(STATUS)!;
    expect(keyLine(s)).toBe("Key set on 2026-11-23 10:00 by Ada");
    expect(webhookLine(s)).toBe("Registered on 2026-11-23 10:00");
    const html = renderToStaticMarkup(<EsignSettingsView status={s} onAction={() => undefined} />);
    expect(html).toContain("On, with SignWell");
    expect(html).toContain('type="password"');
    expect(html).toContain("Check and save key");
    expect(html).toContain("Re-register webhook");
    expect(html).toContain("Remove key");
    expect(html).toContain("not legally binding");
    expect(html).toContain("Never");
    const env = esignStatusFrom({ ...STATUS, key: { set: true, source: "environment" }, test_mode: { on: false, source: "environment" } })!;
    expect(keyLine(env)).toContain("server's environment");
    const envHtml = renderToStaticMarkup(<EsignSettingsView status={env} onAction={() => undefined} />);
    expect(envHtml).not.toContain("data-esign-remove-key");
    expect(envHtml).toContain("legally binding and count towards");
    const off = esignStatusFrom({ ...STATUS, configured: false, key: { set: false }, webhook: { registered: false, can_register: false } })!;
    expect(renderToStaticMarkup(<EsignSettingsView status={off} onAction={() => undefined} />)).toContain("Off: program agreements are signed by hand");
    expect(webhookLine(off)).toContain("isn't https");
  });
});

describe("the route", () => {
  it("admins only, same origin; the key goes to Mynt once and never comes back", async () => {
    const got = await (await route.GET()).json();
    expect(got.settings.key.setBy).toBe("Ada");
    fake.reply.set_esign_api_key = { ok: true, webhook: { registered: true, reused: true }, settings: STATUS };
    const res = await post({ action: "set_key", provider: "signwell", api_key: KEY });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text).message).toContain("an existing one pointing here was reused");
    expect(fake.calls.find((c) => c.name === "set_esign_api_key")?.args).toEqual({ provider: "signwell", api_key: KEY });

    expect((await post({ action: "test_mode", test_mode: false })).status).toBe(200);
    expect(fake.calls.at(-2)).toEqual({ name: "set_esign_test_mode", args: { test_mode: false } });
    expect((await post({ action: "remove_key", confirm: true })).status).toBe(200);
    expect(fake.calls.some((c) => c.name === "remove_esign_api_key")).toBe(true);
    expect((await post({ action: "register_webhook" })).status).toBe(200);

    // Strict: unknown actions, extra fields, a key with spaces, Remove without confirm.
    expect((await post({ action: "set_key", provider: "signwell", api_key: "has spaces in it" })).status).toBe(400);
    expect((await post({ action: "set_key", provider: "other", api_key: KEY })).status).toBe(400);
    expect((await post({ action: "remove_key" })).status).toBe(400);
    expect((await post({ action: "test_mode", test_mode: true, extra: 1 })).status).toBe(400);
    // Mynt's refusal in its words, without the key.
    fake.refuse = "The e-signature service refused that key: check it and paste it again";
    const refused = await post({ action: "set_key", provider: "signwell", api_key: KEY });
    expect(refused.status).toBe(422);
    expect(await refused.text()).not.toContain(KEY);
    fake.refuse = null;

    fake.session = session(["developer", "license_provider"]);
    expect((await route.GET()).status).toBe(403);
    expect((await post({ action: "register_webhook" })).status).toBe(403);
    fake.session = undefined;
    expect((await route.GET()).status).toBe(401);
    fake.session = session(["admin"]);
    fake.sameOrigin = false;
    expect((await post({ action: "register_webhook" })).status).toBe(403);
    fake.sameOrigin = true;
    fake.tools = [];
    expect((await route.GET()).status).toBe(501);
  });
});

describe("frame origins", () => {
  it("learnt from Mynt's adapter list (https only), plus ESIGN_FRAME_SRC; none when Mynt can't be reached", async () => {
    process.env.MYNT_MCP_URL = "https://mynt.example/mcp";
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ origins: ["https://sign.service.test", "http://plain.test", "javascript:x"] }), { status: 200 }));
    expect(await frame.esignFrameOrigins(fetcher as unknown as typeof fetch)).toEqual(["https://sign.service.test"]);
    expect(fetcher).toHaveBeenCalledWith("https://mynt.example/esign/frame-origins", expect.anything());
    // Cached: not asked again at once.
    await frame.esignFrameOrigins(fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
    frame.resetEsignFrameOrigins();
    process.env.ESIGN_FRAME_SRC = "https://override.esign.test";
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await frame.esignFrameOrigins(down as unknown as typeof fetch)).toEqual(["https://override.esign.test"]);
  });
});
