// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@/lib/session-store";
import { agreementFileType, canDownload, canSign, esignFrameSources, esignOf, fromTemplates, framable } from "@/lib/agreement-esign";
import { agreementActions, fromAgreements } from "@/lib/app-panel";
import { lpAgreementsFrom } from "@/lib/lp-agreements";
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
const lp = await import("@/components/lp-agreements-view");

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
    // The licence provider's rows (the Licences page's Agreements tab): Sign is its turn on the e-signature document.
    const rows = lpAgreementsFrom({ agreements: [programRow()] })!;
    expect(rows[0]).toMatchObject({ appName: "Pay app", status: "Accepted: waiting for signatures", products: ["Card"] });
    expect(rows[0].signatures).toBe("You haven't signed; they signed (test mode)");
    expect(rows[0].actions).toEqual(["sign", "end"]);
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
    expect(agreementActions(app.agreements[0], "app")).toEqual(["end"]);
  });

  it("an agreement signed in e-signature test mode reads Signed (test, not binding) on both sides, and the production row says why it doesn't count", async () => {
    const { coverageFrom, coverageText } = await import("@/lib/promotions");
    const completed = (test_mode: boolean) => programRow({ status: "signed", signature_document: { status: "completed", test_mode, signers: { counterparty: { signed: true }, app: { signed: true } }, signed_copy: { sha256: "b".repeat(64) } } });
    const lp = lpAgreementsFrom({ agreements: [completed(true)] })!;
    expect(lp[0].status).toBe("Signed (test, not binding)");
    expect(lp[0].statusKey).toBe("signed");
    expect(lp[0].signatures).toBe("Signed by e-signature (test mode: not legally binding)");
    const app = fromAgreements({ can_manage: true, agreements: [completed(true)], products: [], vendor_contracts: [], introductions: null })!;
    expect(app.agreements[0].status).toBe("Signed (test, not binding)");
    // Signed with test mode off, or by hand, it's simply Signed.
    expect(lpAgreementsFrom({ agreements: [completed(false)] })![0].status).toBe("Signed");
    expect(fromAgreements({ can_manage: true, agreements: [completed(false)], products: [], vendor_contracts: [], introductions: null })!.agreements[0].status).toBe("Signed");
    expect(lpAgreementsFrom({ agreements: [programRow({ status: "signed", signed_by_esignature: false, signature_document: null })] })![0].status).toBe("Signed");
    // The production check's row: not "no agreement", but one that isn't binding, in Mynt's words.
    const [row] = coverageFrom([{ product_id: "p1", product_name: "Card", sponsor_entity_id: "f", sponsor_name: "Lead Bank", covered: false, agreement_id: AGREEMENT, signed_in_test_mode: true, note: "it was signed in the e-signature service's test mode" }]);
    expect(row.covered).toBe(false);
    expect(coverageText(row)).toBe("Signed (test, not binding): it was signed in the e-signature service's test mode");
    expect(coverageText(coverageFrom([{ product_id: "p1", sponsor_entity_id: "f", covered: true }])[0])).toBe("Signed and in force");
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
  it("the Licences page's Agreements tab: Sign opens the e-signature sheet, the signed copy once held; the templates section", () => {
    const rows = lpAgreementsFrom({ agreements: [programRow(), programRow({ id: "55555555-5555-4555-8555-555555555555", status: "signed", signature_document: { status: "completed", signers: {}, signed_copy: { sha256: "d".repeat(64) } } })] })!;
    const html = renderToStaticMarkup(<lp.LpAgreementsView rows={rows} />);
    expect(html).toContain('data-agreement-action="sign"');
    expect(html).toContain("Download signed copy");
    expect(html).toContain("/api/agreements/55555555-5555-4555-8555-555555555555/document?part=signed");
    expect(html).toContain("part=certificate");
    const data = { configured: true, testMode: true, templates: fromTemplates({ templates: [{ id: TEMPLATE, name: "Program", version: 1, active: true, file_name: "p.pdf", sha256: "c".repeat(64) }] })!.templates, licences: [] };
    const t = renderToStaticMarkup(<ui.AgreementTemplatesSection data={data} />);
    expect(t).toContain("Upload agreement template");
    expect(t).toContain("Retire");
    expect(t).toContain("test mode");
    const off = renderToStaticMarkup(<ui.AgreementTemplatesSection data={{ ...data, configured: false, templates: [] }} />);
    expect(off).toContain("E-signature isn&#x27;t configured on this deployment yet");
    expect(off).toContain("data-no-templates");
  });

  it("Sign on an e-signature row opens the signing sheet, not the manual one", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, url: "https://sign.service.test/embed/1", framable: false }), { status: 200 }));
    render(<lp.LpAgreementsView rows={lpAgreementsFrom({ agreements: [programRow()] })!} fetcher={fetcher as unknown as typeof fetch} />);
    await act(async () => {
      fireEvent.click(document.querySelector('[data-agreement-action="sign"]')!);
    });
    expect(fetcher).toHaveBeenCalledWith(`/api/agreements/${AGREEMENT}/signing-link`, { method: "POST" });
    expect(await screen.findByText("Open the signing page")).toBeTruthy();
  });

  it("the signed copy's links: only once Mynt holds it", () => {
    const signed = esignOf(programRow({ status: "signed", signature_document: { status: "completed", signers: {}, signed_copy: { sha256: "d".repeat(64) } } }));
    expect(renderToStaticMarkup(<ui.SignedCopyLinks agreementId={AGREEMENT} esign={signed} />)).toContain("Download signed copy");
    expect(renderToStaticMarkup(<ui.SignedCopyLinks agreementId={AGREEMENT} esign={esignOf(programRow())} />)).toBe("");
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
