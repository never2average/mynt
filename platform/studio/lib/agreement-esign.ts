// Program agreements signed by e-signature, as the studio shows them (Mynt: core/src/agreement-esign.ts): a licence
// provider's agreement templates, each agreement's signature document (who has signed, whether Mynt holds the signed
// copy), and whether a signing page may be framed here. Pure, for the pages and the tests.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// The largest template the studio sends (Mynt's own limit).
export const AGREEMENT_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const AGREEMENT_FILE_TYPES = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } as const;

// What a file is, by its name and first bytes: a PDF, or a Word document (a zip). Mynt checks it again.
export function agreementFileType(name: string, head: Uint8Array): "pdf" | "docx" | null {
  const lower = name.toLowerCase();
  const pdf = head.length >= 5 && String.fromCharCode(...head.slice(0, 5)) === "%PDF-";
  const zip = head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  if (lower.endsWith(".pdf") && pdf) return "pdf";
  if (lower.endsWith(".docx") && zip) return "docx";
  return null;
}

export type EsignInfo = {
  byEsign: boolean; // this deployment signs the agreement by e-signature
  status: string | null; // the document's, once made
  testMode: boolean;
  appSigned: boolean;
  counterpartySigned: boolean;
  signedCopy: boolean; // Mynt holds the signed copy
  template: string | null; // "name, version n"
  templateId?: string | null; // the agreement template (MSA) version the document was made from
};

export function esignOf(agreement: unknown): EsignInfo | null {
  if (!isObj(agreement) || agreement.kind !== "program") return null;
  const d = isObj(agreement.signature_document) ? agreement.signature_document : null;
  const signers = d && isObj(d.signers) ? d.signers : {};
  const signed = (side: string) => isObj(signers[side]) && (signers[side] as Record<string, unknown>).signed === true;
  const t = d && isObj(d.template) ? d.template : null;
  return {
    byEsign: agreement.signed_by_esignature === true,
    status: d ? str(d.status) : null,
    testMode: d?.test_mode === true,
    appSigned: signed("app"),
    counterpartySigned: signed("counterparty"),
    signedCopy: Boolean(d && isObj(d.signed_copy)),
    template: t && str(t.name) ? `${str(t.name)}, version ${typeof t.version === "number" ? t.version : "?"}` : null,
    templateId: t ? str(t.id) : null,
  };
}

// A program agreement signed by an e-signature document made in the service's test mode: signed, but not legally
// binding, so Mynt doesn't count it for production (core/src/app-agreements.ts). Its status says so.
export const SIGNED_IN_TEST_MODE = "Signed (test, not binding)";
export const signedInTestMode = (statusKey: string, e: EsignInfo | null) => statusKey === "signed" && Boolean(e?.testMode && e.signedCopy);

// Where an e-signature stands, in words, for one side.
export function esignStatusLine(e: EsignInfo, side: "app" | "counterparty"): string | null {
  if (!e.byEsign) return null;
  if (e.signedCopy) return `Signed by e-signature${e.testMode ? " (test mode: not legally binding)" : ""}`;
  if (!e.status) return "Waiting for the signature document";
  const mine = side === "app" ? e.appSigned : e.counterpartySigned;
  const theirs = side === "app" ? e.counterpartySigned : e.appSigned;
  return `${mine ? "You signed" : "You haven't signed"}; ${theirs ? "they signed" : "they haven't signed"}${e.testMode ? " (test mode)" : ""}`;
}

export type TemplateRow = {
  id: string;
  name: string;
  version: number;
  attachedTo: string; // in words
  file: string | null;
  sha256: string | null;
  active: boolean;
  createdAt: string | null;
  notes: string | null;
};

export function fromTemplates(reply: unknown): { templates: TemplateRow[]; configured: boolean; testMode: boolean | null } | null {
  if (!isObj(reply) || !Array.isArray(reply.templates)) return null;
  return {
    configured: reply.e_signature_configured === true,
    testMode: typeof reply.test_mode === "boolean" ? reply.test_mode : null,
    templates: arr(reply.templates)
      .filter(isObj)
      .flatMap((t): TemplateRow[] => {
        const id = str(t.id);
        if (!id) return [];
        return [
          {
            id,
            name: str(t.name) ?? "Untitled",
            version: typeof t.version === "number" ? t.version : 1,
            attachedTo: str(t.sponsorship_id) ? "A sponsorship" : str(t.licence_id) ? "A licence" : "Your firm's default",
            file: str(t.file_name) ?? (str(t.provider_template_id) ? "Kept at the e-signature service" : null),
            sha256: str(t.sha256),
            active: t.active === true,
            createdAt: str(t.created_at),
            notes: str(t.notes),
          },
        ];
      }),
  };
}

// Whether a row offers Sign / Download signed copy, for the side looking at it.
export const canSign = (statusKey: string, e: EsignInfo | null, side: "app" | "counterparty") =>
  Boolean(e?.byEsign && statusKey === "accepted" && !(side === "app" ? e.appSigned : e.counterpartySigned));
export const canDownload = (e: EsignInfo | null) => Boolean(e?.signedCopy);

// The origins the studio may frame a signing page from (ESIGN_FRAME_SRC, https origins, a leading "*." allowed),
// and whether a signing link is from one of them.
const FRAME_ORIGIN = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i;
export function esignFrameSources(raw: string | undefined): string[] {
  return (raw ?? "").split(/[\s,]+/).filter((s) => s && FRAME_ORIGIN.test(s));
}
export function framable(url: string, sources: string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  return sources.some((s) => {
    const src = new URL(s.replace("*.", "wildcard."));
    if (src.port !== u.port) return false;
    if (!s.includes("*.")) return src.hostname === u.hostname;
    const base = src.hostname.slice("wildcard.".length);
    return u.hostname.endsWith(`.${base}`);
  });
}
