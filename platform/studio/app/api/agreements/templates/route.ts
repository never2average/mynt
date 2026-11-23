import { z } from "zod";
import { AGREEMENT_FILE_MAX_BYTES, agreementFileType, fromTemplates } from "@/lib/agreement-esign";
import { asAgreementParty, hasTool, NOT_YET } from "@/lib/agreement-esign-server";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool } from "@/lib/studio-server";
import { STUDIO_TOOLS } from "@/lib/studio-tools";
import { json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// The Upload agreement template sheet's form: the name, the file (a PDF or DOCX, at most 5 MB), what it's attached to
// and notes on it. The type is checked by the file's bytes here and again by Mynt, which keeps it sealed.
const Fields = z
  .object({
    name: STUDIO_TOOLS.upload_agreement_template.shape.name,
    licence_id: z.preprocess((v) => (v === "" ? undefined : v), STUDIO_TOOLS.upload_agreement_template.shape.licence_id),
    signature_placement: z.preprocess((v) => (v === "" ? undefined : v), STUDIO_TOOLS.upload_agreement_template.shape.signature_placement),
    notes: z.preprocess((v) => (v === "" ? undefined : v), STUDIO_TOOLS.upload_agreement_template.shape.notes),
  })
  .strict();

// GET: the licence provider's agreement templates for the Licences page's Agreements tab, whether e-signature is on
// (and in test mode), and its firm's licences for the Upload agreement template sheet. Licence providers only.
export async function GET() {
  return asAgreementParty(
    "reading a firm's agreement templates",
    async (mynt) => {
      if (!(await hasTool(mynt, "list_agreement_templates"))) return NOT_YET;
      const [templates, licences] = await Promise.all([callStudioTool(mynt, "list_agreement_templates", { include_retired: true }), callStudioTool(mynt, "list_my_licenses", {}).catch(() => null)]);
      const t = fromTemplates(templates);
      const lics = (licences && typeof licences === "object" && Array.isArray((licences as { licences?: unknown }).licences) ? (licences as { licences: Record<string, unknown>[] }).licences : [])
        .filter((l) => typeof l?.id === "string")
        .map((l) => ({ id: l.id as string, label: [l.license_id, l.registration_number, l.jurisdiction].filter((x) => typeof x === "string" && x).join(" · ") || "Licence" }));
      return json({ configured: t?.configured ?? false, testMode: t?.testMode ?? null, templates: t?.templates ?? [], licences: lics });
    },
    true,
  );
}

// POST (multipart/form-data): upload a template. Same origin and a signed-in licence provider only.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const declared = Number(req.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > AGREEMENT_FILE_MAX_BYTES + 64 * 1024) return json({ error: "too_large", message: "The file is over 5 MB." }, 413);
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) return json({ error: "bad_request", message: "Send the form with its file." }, 400);
  const form = await req.formData().catch(() => null);
  if (!form) return json({ error: "bad_request", message: "That form couldn't be read." }, 400);
  const file = form.get("file");
  // A file part (a Blob with a name), whichever File class the runtime's form parser made.
  if (!file || typeof file === "string" || typeof (file as Blob).arrayBuffer !== "function") return json({ error: "bad_request", message: "Choose the agreement's file." }, 400);
  if (file.size > AGREEMENT_FILE_MAX_BYTES) return json({ error: "too_large", message: "The file is over 5 MB." }, 413);
  if (!file.size) return json({ error: "bad_request", message: "The file is empty." }, 400);
  const fields = Fields.safeParse({ name: form.get("name"), licence_id: form.get("licence_id") ?? undefined, signature_placement: form.get("signature_placement") ?? undefined, notes: form.get("notes") ?? undefined });
  if (!fields.success) return json({ error: "bad_request", message: fields.error.issues[0]?.message ?? "That template isn't valid." }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const fileName = (file as File).name.replace(/[/\\\0]/g, "_").slice(-150);
  if (!agreementFileType(fileName, bytes.slice(0, 8))) return json({ error: "bad_request", message: "Upload a PDF or a Word document (.docx)." }, 400);
  return asAgreementParty(
    "uploading an agreement template",
    async (mynt) => {
      if (!(await hasTool(mynt, "upload_agreement_template"))) return NOT_YET;
      const args = Object.fromEntries(Object.entries({ ...fields.data, source: "upload", file_name: fileName, file_base64: Buffer.from(bytes).toString("base64") }).filter(([, v]) => v !== undefined));
      const t = (await callStudioTool(mynt, "upload_agreement_template", args)) as { version?: number } | null;
      return json({ ok: true, message: `Uploaded as version ${t?.version ?? 1}. Mynt uses it for program agreements your firm accepts from now on.` });
    },
    true,
  );
}
