// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";

// The routes behind the studio's e-signature actions (components/agreement-esign.tsx): same origin, signed in, the
// right role, strict arguments, and the file's type (by its bytes) and size checked before Mynt sees it. In Node, as
// the routes run, so the form parser is the server's own.

const AGREEMENT = "33333333-3333-4333-8333-333333333333";
const PDF = new TextEncoder().encode("%PDF-1.4\nprogram\n%%EOF\n");

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
      const ok = (d: unknown) => ({ content: [{ type: "text", text: JSON.stringify(d) }] });
      if (fake.refuse) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: fake.refuse }) }] };
      return ok(fake.reply[name] ?? { ok: true });
    },
    close: async () => undefined,
  }),
}));

const templatesRoute = await import("@/app/api/agreements/templates/route");
const linkRoute = await import("@/app/api/agreements/[agreementId]/signing-link/route");
const documentRoute = await import("@/app/api/agreements/[agreementId]/document/route");
const listRoute = await import("@/app/api/agreements/route");

const session = (roles: string[]) => ({ id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles, rolesAt: Date.now() }) as Session;
beforeEach(() => {
  fake.session = session(["license_provider"]);
  fake.sameOrigin = true;
  fake.tools = ["upload_agreement_template", "list_agreement_templates", "retire_agreement_template", "get_agreement_signing_link", "download_agreement_document", "list_app_agreements", "list_my_licenses"].map((name) => ({ name }));
  fake.calls = [];
  fake.refuse = null;
  fake.reply = {};
  delete process.env.ESIGN_FRAME_SRC;
});

const programRow = () => ({
  id: AGREEMENT,
  kind: "program",
  status: "accepted",
  app: { id: "a1", name: "Pay app" },
  products: [{ id: "p1", name: "Card" }],
  signed_by_esignature: true,
  signature_document: { status: "pending", signers: { counterparty: { signed: false }, app: { signed: true } } },
});

const upload = (fields: Record<string, string | File>, headers: Record<string, string> = {}) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request("http://studio.test/api/agreements/templates", { method: "POST", body: form, headers });
};

describe("the routes", () => {
  it("upload: licence providers only, same origin, PDF or DOCX by its bytes, at most 5 MB, strict arguments", async () => {
    const good = { name: "Program agreement", licence_id: "", notes: "", file: new File([PDF], "program.pdf", { type: "application/pdf" }) };
    fake.reply.upload_agreement_template = { version: 3 };
    const res = await templatesRoute.POST(upload(good));
    expect(res.status).toBe(200);
    expect((await res.json()).message).toContain("version 3");
    const call = fake.calls.find((c) => c.name === "upload_agreement_template")!;
    expect(call.args).toMatchObject({ name: "Program agreement", source: "upload", file_name: "program.pdf" });
    expect(Buffer.from(call.args.file_base64 as string, "base64").toString()).toBe(new TextDecoder().decode(PDF));
    expect(call.args).not.toHaveProperty("licence_id");

    expect((await templatesRoute.POST(upload({ ...good, file: new File(["<html>"], "program.pdf") }))).status).toBe(400);
    expect((await templatesRoute.POST(upload({ ...good, file: new File([PDF], "program.exe") }))).status).toBe(400);
    expect((await templatesRoute.POST(upload({ ...good, file: new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.pdf") }))).status).toBe(413);
    expect((await templatesRoute.POST(upload({ ...good, licence_id: "not-a-uuid" }))).status).toBe(400);
    fake.sameOrigin = false;
    expect((await templatesRoute.POST(upload(good))).status).toBe(403);
    fake.sameOrigin = true;
    fake.session = session(["developer"]);
    expect((await templatesRoute.POST(upload(good))).status).toBe(403);
    fake.session = undefined;
    expect((await templatesRoute.POST(upload(good))).status).toBe(401);
  });

  it("signing link: framable only from ESIGN_FRAME_SRC; Mynt's refusal in its words; same origin only", async () => {
    fake.session = session(["developer"]);
    fake.reply.get_agreement_signing_link = { signing_url: "https://sign.service.test/embed/1", test_mode: true };
    const params = { params: Promise.resolve({ agreementId: AGREEMENT }) };
    const post = () => linkRoute.POST(new Request(`http://studio.test/api/agreements/${AGREEMENT}/signing-link`, { method: "POST" }), params);
    let body = await (await post()).json();
    expect(body).toMatchObject({ url: "https://sign.service.test/embed/1", framable: false, testMode: true });
    process.env.ESIGN_FRAME_SRC = "https://sign.service.test";
    body = await (await post()).json();
    expect(body.framable).toBe(true);
    expect(fake.calls.at(-1)).toEqual({ name: "get_agreement_signing_link", args: { agreement_id: AGREEMENT } });
    fake.refuse = "Lena signs this for your side";
    const refused = await post();
    expect(refused.status).toBe(422);
    expect((await refused.json()).message).toContain("Lena signs this for your side");
    expect((await linkRoute.POST(new Request("http://studio.test/x", { method: "POST" }), { params: Promise.resolve({ agreementId: "nope" }) })).status).toBe(400);
    fake.sameOrigin = false;
    expect((await post()).status).toBe(403);
  });

  it("download: a PDF attachment, never cached; Mynt without the tool says it's coming", async () => {
    fake.session = session(["developer"]);
    fake.reply.download_agreement_document = { content_base64: Buffer.from(PDF).toString("base64"), sha256: "e".repeat(64) };
    const res = await documentRoute.GET(new Request(`http://studio.test/api/agreements/${AGREEMENT}/document?part=certificate`), { params: Promise.resolve({ agreementId: AGREEMENT }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()))).toBe(new TextDecoder().decode(PDF));
    expect(fake.calls.at(-1)?.args).toEqual({ agreement_id: AGREEMENT, part: "certificate" });
    fake.tools = [];
    expect((await documentRoute.GET(new Request(`http://studio.test/api/agreements/${AGREEMENT}/document`), { params: Promise.resolve({ agreementId: AGREEMENT }) })).status).toBe(501);
  });

  it("the Agreements page's data: licence providers only", async () => {
    fake.reply.list_agreement_templates = { e_signature_configured: false, templates: [] };
    fake.reply.list_app_agreements = { agreements: [programRow()] };
    fake.reply.list_my_licenses = { licences: [{ id: "l1", license_id: "money-transmitter", registration_number: "123", jurisdiction: "us-ny" }] };
    const body = await (await listRoute.GET()).json();
    expect(body.configured).toBe(false);
    expect(body.agreements[0].appName).toBe("Pay app");
    expect(body.licences).toEqual([{ id: "l1", label: "money-transmitter · 123 · us-ny" }]);
    expect(fake.calls.find((c) => c.name === "list_app_agreements")?.args).toEqual({});
    fake.session = session(["developer"]);
    expect((await listRoute.GET()).status).toBe(403);
  });
});
