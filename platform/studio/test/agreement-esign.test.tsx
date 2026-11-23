// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@/lib/session-store";
import { agreementFileType, canDownload, canSign, esignFrameSources, esignOf, fromFirmAgreements, fromTemplates, framable } from "@/lib/agreement-esign";
import { fromAgreements } from "@/lib/app-panel";
import { contentSecurityPolicy } from "@/lib/csp";

// Program agreements signed by e-signature in the studio: a licence provider's templates (Upload agreement template,
// Retire), Sign (the signer's embedded signing page, framed only from an allowed origin) and Download signed copy on
// both sides' rows, and the routes behind them (same origin, signed in, the right role, strict arguments, size and
// type limits on the file: test/agreement-esign-routes.test.ts).

const AGREEMENT = "33333333-3333-4333-8333-333333333333";
const TEMPLATE = "44444444-4444-4444-8444-444444444444";
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

const ui = await import("@/components/agreement-esign");

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
afterEach(() => cleanup());

const programRow = (over: Record<string, unknown> = {}) => ({
  id: AGREEMENT,
  kind: "program",
  status: "accepted",
  app: { id: "a1", name: "Pay app" },
  counterparty: { entity_id: "f", name: "Lead Bank" },
  products: [{ id: "p1", name: "Card" }],
  signed_by_esignature: true,
  signature_document: { status: "pending", test_mode: true, template: { name: "Program", version: 2 }, signers: { counterparty: { signed: false }, app: { signed: true } }, signed_copy: null },
  ...over,
});

describe("reading Mynt's replies", () => {
  it("templates, a firm's agreements and each row's e-signature", () => {
    const t = fromTemplates({ e_signature_configured: true, test_mode: true, templates: [{ id: TEMPLATE, name: "Program", version: 2, sponsorship_id: null, licence_id: "l1", file_name: "p.pdf", sha256: "a".repeat(64), active: true, created_at: "2026-11-20T00:00:00Z" }] })!;
    expect(t.configured).toBe(true);
    expect(t.templates[0]).toMatchObject({ name: "Program", version: 2, attachedTo: "A licence", file: "p.pdf", active: true });
    const rows = fromFirmAgreements({ agreements: [programRow()] })!;
    expect(rows[0]).toMatchObject({ app: "Pay app", status: "Accepted: waiting for signatures", products: ["Card"] });
    expect(rows[0].signatures).toBe("You haven't signed; they signed (test mode)");
    expect(canSign("accepted", rows[0].esign, "counterparty")).toBe(true);
    expect(canSign("accepted", rows[0].esign, "app")).toBe(false);
    expect(canDownload(rows[0].esign)).toBe(false);
    const done = esignOf(programRow({ status: "signed", signature_document: { status: "completed", signers: { counterparty: { signed: true }, app: { signed: true } }, signed_copy: { sha256: "b".repeat(64) } } }));
    expect(canDownload(done)).toBe(true);
    expect(canSign("signed", done, "app")).toBe(false);
    // Without e-signature (the manual flow), no Sign button here.
    expect(canSign("accepted", esignOf(programRow({ signed_by_esignature: false, signature_document: null })), "app")).toBe(false);
    expect(esignOf({ kind: "vendor" })).toBeNull();
    // The app side's rows carry it too.
    const app = fromAgreements({ can_manage: true, agreements: [programRow()], products: [], vendor_contracts: [], introductions: null })!;
    expect(app.agreements[0].esign?.appSigned).toBe(true);
    expect(app.agreements[0].signatures).toBe("You signed; they haven't signed (test mode)");
  });

  it("files by their bytes; signing pages framed only from the allowed origins, which the policy lists", () => {
    expect(agreementFileType("a.pdf", PDF)).toBe("pdf");
    expect(agreementFileType("a.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe("docx");
    expect(agreementFileType("a.pdf", new TextEncoder().encode("<html>"))).toBeNull();
    expect(agreementFileType("a.exe", PDF)).toBeNull();
    const sources = esignFrameSources("https://sign.service.test https://*.esign.test javascript:alert(1)");
    expect(sources).toEqual(["https://sign.service.test", "https://*.esign.test"]);
    expect(framable("https://sign.service.test/embed/x", sources)).toBe(true);
    expect(framable("https://app.esign.test/embed/x", sources)).toBe(true);
    expect(framable("https://evil.test/embed/x", sources)).toBe(false);
    expect(framable("http://sign.service.test/embed/x", sources)).toBe(false);
    expect(contentSecurityPolicy("https://sign.service.test")).toContain("frame-src https://sign.service.test");
  });
});

describe("the views", () => {
  it("a licence provider's Agreements page: both tables, labelled actions, test mode and not-configured notes", () => {
    const data = { configured: true, testMode: true, templates: fromTemplates({ templates: [{ id: TEMPLATE, name: "Program", version: 1, active: true, file_name: "p.pdf", sha256: "c".repeat(64) }] })!.templates, agreements: fromFirmAgreements({ agreements: [programRow()] })!, licences: [] };
    const html = renderToStaticMarkup(<ui.FirmAgreementsView data={data} />);
    expect(html).toContain("Upload agreement template");
    expect(html).toContain("data-agreement-sign");
    expect(html).toContain("Retire");
    expect(html).toContain("test mode");
    expect(html).not.toContain("Download signed copy");
    const off = renderToStaticMarkup(<ui.FirmAgreementsView data={{ ...data, configured: false, templates: [], agreements: [] }} />);
    expect(off).toContain("E-signature isn&#x27;t configured on this deployment yet");
    expect(off).toContain("data-no-templates");
  });

  it("row actions: Sign while it's the side's turn, Download signed copy once Mynt holds it", () => {
    const signed = esignOf(programRow({ status: "signed", signature_document: { status: "completed", signers: {}, signed_copy: { sha256: "d".repeat(64) } } }));
    const html = renderToStaticMarkup(<ui.AgreementRowActions agreementId={AGREEMENT} esign={signed} statusKey="signed" side="app" />);
    expect(html).toContain("Download signed copy");
    expect(html).toContain(`/api/agreements/${AGREEMENT}/document?part=signed`);
    expect(html).toContain("part=certificate");
    expect(html).not.toContain("data-agreement-sign");
    const member = renderToStaticMarkup(<ui.AgreementRowActions agreementId={AGREEMENT} esign={esignOf(programRow({ signature_document: { status: "pending", signers: {} } }))} statusKey="accepted" side="app" canAct={false} />);
    expect(member).not.toContain("data-agreement-sign");
  });

  it("the signing sheet frames an allowed page, and otherwise offers it in a new tab", () => {
    const framed = renderToStaticMarkup(<ui.SigningView signing={{ state: "ready", url: "https://sign.service.test/embed/1", framable: true, testMode: true }} />);
    expect(framed).toContain("<iframe");
    expect(framed).toContain("isn&#x27;t legally binding");
    const tab = renderToStaticMarkup(<ui.SigningView signing={{ state: "ready", url: "https://sign.service.test/embed/1", framable: false, testMode: false }} />);
    expect(tab).not.toContain("<iframe");
    expect(tab).toContain('target="_blank"');
    expect(tab).toContain('rel="noopener noreferrer"');
  });

  it("Upload agreement template sends the form with its file", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ message: "Uploaded as version 1." }), { status: 200 }));
    const onDone = vi.fn();
    render(<ui.UploadTemplateSheet licences={[{ id: "l1", label: "Money transmitter · NY" }]} open onClose={() => undefined} onDone={onDone} fetcher={fetcher as unknown as typeof fetch} />);
    fireEvent.change(document.querySelector("[data-template-name]")!, { target: { value: "Program agreement" } });
    fireEvent.change(document.querySelector("[data-template-licence]")!, { target: { value: "l1" } });
    const file = new File([PDF], "program.pdf", { type: "application/pdf" });
    await act(async () => {
      fireEvent.change(document.querySelector("[data-template-file]")!, { target: { files: [file] } });
    });
    const submit = document.querySelector("[data-upload-template-submit]") as HTMLButtonElement;
    await vi.waitFor(() => expect(submit.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(submit);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/agreements/templates");
    const form = init!.body as FormData;
    expect(form.get("name")).toBe("Program agreement");
    expect(form.get("licence_id")).toBe("l1");
    expect((form.get("file") as File).name).toBe("program.pdf");
    expect(await screen.findByText("Uploaded as version 1.")).toBeTruthy();
    expect(onDone).toHaveBeenCalled();
  });
});
