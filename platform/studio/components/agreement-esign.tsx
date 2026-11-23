"use client"

// Program agreements signed by e-signature, in the studio (lib/agreement-esign.ts):
// - Upload agreement template (a licence provider's Agreements page): a labelled button opening a sheet with the
//   template's name, what it's attached to (a licence, or the firm's default), the file (PDF or DOCX, at most 5 MB)
//   and notes on where fields go. Mynt keeps the file sealed, with its SHA-256; versions never change.
// - Sign (either side's agreement rows): a sheet with the signer's embedded signing page, framed only from an origin
//   the deployment allows (ESIGN_FRAME_SRC), otherwise offered in a new tab. Only Mynt decides who signs.
// - Download signed copy: the PDF Mynt keeps once both have signed, and the audit certificate beside it.
// Mynt checks everything again and may refuse; its reason is shown in its own words. Views render on the server
// for the tests.
import { useCallback, useEffect, useState } from "react"
import { Download, FilePlus2, PenLine } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AGREEMENT_FILE_MAX_BYTES, agreementFileType, canDownload, canSign, type EsignInfo, type FirmAgreementRow, type TemplateRow } from "@/lib/agreement-esign"

const field = "rounded-md border border-input bg-background px-2 py-1.5 text-sm"
const signedOut = (status: number | undefined) => {
  if (status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("mynt:signed-out"))
}

// A file's first bytes, to check what it is before it's sent (Mynt checks again).
function readHead(f: Blob): Promise<Uint8Array> {
  const part = f.slice(0, 8)
  if (typeof part.arrayBuffer === "function") return part.arrayBuffer().then((b) => new Uint8Array(b))
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer))
    r.onerror = () => resolve(new Uint8Array())
    r.readAsArrayBuffer(part)
  })
}

export type Licence = { id: string; label: string }
export type TemplateUpload = { name: string; licence_id: string; signature_placement: "signature_page" | "text_tags"; notes: string; file: File }

export function UploadTemplateView({
  licences,
  busy = false,
  error = null,
  result = null,
  onSubmit,
}: {
  licences: Licence[]
  busy?: boolean
  error?: string | null
  result?: string | null
  onSubmit: (u: TemplateUpload) => void
}) {
  const [name, setName] = useState("")
  const [licence, setLicence] = useState("")
  const [placement, setPlacement] = useState<TemplateUpload["signature_placement"]>("signature_page")
  const [notes, setNotes] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const pick = async (f: File | null) => {
    setFile(null)
    setFileError(null)
    if (!f) return
    if (f.size > AGREEMENT_FILE_MAX_BYTES) return setFileError("That file is over 5 MB.")
    const head = await readHead(f)
    if (!agreementFileType(f.name, head)) return setFileError("Choose a PDF or a Word document (.docx).")
    setFile(f)
  }
  return (
    <form
      className="flex flex-col gap-3"
      data-upload-template-form
      onSubmit={(e) => {
        e.preventDefault()
        if (file) onSubmit({ name: name.trim(), licence_id: licence, signature_placement: placement, notes: notes.trim(), file })
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required placeholder="Program agreement" data-template-name />
        <span className="text-xs text-muted-foreground">The same name again adds the next version; earlier versions stay as they were.</span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Licence
        <select className={field} value={licence} onChange={(e) => setLicence(e.target.value)} data-template-licence>
          <option value="">Your firm&apos;s default (any licence)</option>
          {licences.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        File (PDF or Word, at most 5 MB)
        <input className={field} type="file" accept=".pdf,.docx,application/pdf" onChange={(e) => void pick(e.target.files?.[0] ?? null)} data-template-file />
        {fileError && <span className="text-xs text-destructive" data-template-file-error>{fileError}</span>}
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Signatures
        <select className={field} value={placement} onChange={(e) => setPlacement(e.target.value as TemplateUpload["signature_placement"])} data-template-placement>
          <option value="signature_page">A signature page added at the end</option>
          <option value="text_tags">Where the file&apos;s signature tags are</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Field placement notes (optional)
        <textarea className={`${field} min-h-20`} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} data-template-notes />
        <span className="text-xs text-muted-foreground">Mynt adds a program schedule naming both parties, the app, the products, the states and the dates.</span>
      </label>
      {result === null && (
        <div>
          <Button type="submit" disabled={busy || name.trim().length < 3 || !file} data-upload-template-submit>
            {busy ? "Uploading…" : "Upload agreement template"}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive" data-template-error>
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="text-sm font-medium" data-template-result>
          {result}
        </p>
      )}
    </form>
  )
}

export function UploadTemplateSheet({ licences, open, onClose, onDone, fetcher = (...a) => fetch(...a) }: { licences: Licence[]; open: boolean; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  useEffect(() => {
    if (!open) return
    setError(null)
    setResult(null)
    setRound((r) => r + 1)
  }, [open])
  const submit = async (u: TemplateUpload) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const form = new FormData()
    form.set("name", u.name)
    form.set("licence_id", u.licence_id)
    form.set("signature_placement", u.signature_placement)
    form.set("notes", u.notes)
    form.set("file", u.file, u.file.name)
    const res = await fetcher("/api/agreements/templates", { method: "POST", body: form }).catch(() => null)
    const data = (await res?.json().catch(() => null)) as { message?: string } | null
    setBusy(false)
    signedOut(res?.status)
    if (!res?.ok) return setError(data?.message ?? "Couldn't reach Mynt. Please try again.")
    setResult(data?.message ?? "Uploaded.")
    onDone()
  }
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" data-upload-template-sheet>
        <SheetHeader>
          <SheetTitle>Upload agreement template</SheetTitle>
          <SheetDescription>Your firm&apos;s program agreement, which apps sign with you by e-signature once you accept their program agreement. Kept sealed by Mynt and recorded in the audit trail.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          <UploadTemplateView key={round} licences={licences} busy={busy} error={error} result={result} onSubmit={(u) => void submit(u)} />
        </div>
      </SheetContent>
    </Sheet>
  )
}

type Signing = { state: "loading" } | { state: "error"; message: string } | { state: "done"; message: string } | { state: "ready"; url: string; framable: boolean; testMode: boolean }

export function SigningView({ signing }: { signing: Signing }) {
  if (signing.state === "loading") return <p className="text-sm text-muted-foreground">Opening the signing page…</p>
  if (signing.state === "error")
    return (
      <p role="alert" className="text-sm text-destructive" data-signing-error>
        {signing.message}
      </p>
    )
  if (signing.state === "done")
    return (
      <p role="status" className="text-sm" data-signing-done>
        {signing.message}
      </p>
    )
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-signing-ready>
      {signing.testMode && <p className="text-xs text-muted-foreground">Test mode: this signature isn&apos;t legally binding.</p>}
      {signing.framable ? (
        <iframe title="Sign the agreement" src={signing.url} className="min-h-[70vh] w-full flex-1 rounded-md border" referrerPolicy="no-referrer" data-signing-frame />
      ) : (
        <p className="text-sm">
          The signing page opens on the e-signature service.{" "}
          <a href={signing.url} target="_blank" rel="noopener noreferrer" className="font-medium underline" data-signing-link>
            Open the signing page
          </a>
          , then come back here: the agreement shows as signed once both sides have signed.
        </p>
      )}
    </div>
  )
}

export function SigningSheet({ agreementId, open, onClose, fetcher = (...a) => fetch(...a) }: { agreementId: string; open: boolean; onClose: () => void; fetcher?: typeof fetch }) {
  const [signing, setSigning] = useState<Signing>({ state: "loading" })
  const load = useCallback(async () => {
    setSigning({ state: "loading" })
    const res = await fetcher(`/api/agreements/${encodeURIComponent(agreementId)}/signing-link`, { method: "POST" }).catch(() => null)
    const data = (await res?.json().catch(() => null)) as { url?: string | null; framable?: boolean; testMode?: boolean; message?: string } | null
    signedOut(res?.status)
    if (!res?.ok) return setSigning({ state: "error", message: data?.message ?? "Couldn't reach Mynt. Please try again." })
    if (!data?.url) return setSigning({ state: "done", message: data?.message ?? "There's nothing for you to sign on it right now." })
    setSigning({ state: "ready", url: data.url, framable: data.framable === true, testMode: data.testMode === true })
  }, [agreementId, fetcher])
  useEffect(() => {
    if (open) void load()
  }, [open, load])
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-3xl" data-signing-sheet>
        <SheetHeader>
          <SheetTitle>Sign the agreement</SheetTitle>
          <SheetDescription>Signed through Mynt&apos;s e-signature service. The agreement is signed once both sides have signed; Mynt then keeps the signed copy.</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-6">
          <SigningView signing={signing} />
        </div>
      </SheetContent>
    </Sheet>
  )
}

// The labelled actions on an agreement row, for the side looking at it.
export function AgreementRowActions({ agreementId, esign, statusKey, side, canAct = true, onChanged }: { agreementId: string; esign: EsignInfo | null; statusKey: string; side: "app" | "counterparty"; canAct?: boolean; onChanged?: () => void }) {
  const [signing, setSigning] = useState(false)
  const sign = canAct && canSign(statusKey, esign, side)
  const download = canDownload(esign)
  if (!sign && !download) return <span className="text-xs text-muted-foreground">—</span>
  const href = (part: string) => `/api/agreements/${encodeURIComponent(agreementId)}/document?part=${part}`
  return (
    <div className="flex flex-wrap gap-2" data-agreement-actions={agreementId}>
      {sign && (
        <Button size="sm" variant="outline" onClick={() => setSigning(true)} data-agreement-sign={agreementId}>
          <PenLine /> Sign
        </Button>
      )}
      {download && (
        <>
          <Button size="sm" variant="outline" asChild>
            <a href={href("signed")} data-agreement-download={agreementId}>
              <Download /> Download signed copy
            </a>
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <a href={href("certificate")} data-agreement-certificate={agreementId}>
              Download certificate
            </a>
          </Button>
        </>
      )}
      {sign && (
        <SigningSheet
          agreementId={agreementId}
          open={signing}
          onClose={() => {
            setSigning(false)
            onChanged?.()
          }}
        />
      )}
    </div>
  )
}

const when = (v: string | null) => (v ? v.slice(0, 10) : "—")

export type FirmAgreements = { configured: boolean; testMode: boolean | null; templates: TemplateRow[]; agreements: FirmAgreementRow[]; licences: Licence[] }

// A licence provider's Agreements page: the agreements apps made with its firm (Sign, Download signed copy), and its
// agreement templates (Upload agreement template, Retire).
export function FirmAgreementsView({ data, onChanged, fetcher = (...a) => fetch(...a) }: { data: FirmAgreements; onChanged?: () => void; fetcher?: typeof fetch }) {
  const [uploading, setUploading] = useState(false)
  const [retireError, setRetireError] = useState<string | null>(null)
  const retire = async (id: string) => {
    setRetireError(null)
    const res = await fetcher(`/api/agreements/templates/${encodeURIComponent(id)}/retire`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null)
    const body = (await res?.json().catch(() => null)) as { message?: string } | null
    signedOut(res?.status)
    if (!res?.ok) return setRetireError(body?.message ?? "Couldn't reach Mynt. Please try again.")
    onChanged?.()
  }
  return (
    <div className="flex flex-col gap-6" data-firm-agreements>
      {!data.configured && (
        <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground" data-esign-not-configured>
          E-signature isn&apos;t configured on this deployment yet. You can upload templates now; until it&apos;s on, both sides record their signatures by hand.
        </p>
      )}
      {data.configured && data.testMode && (
        <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground" data-esign-test-mode>
          E-signature is in test mode: documents signed now aren&apos;t legally binding.
        </p>
      )}
      <section className="flex flex-col gap-3" aria-labelledby="firm-agreements">
        <div>
          <h2 id="firm-agreements" className="text-base font-semibold">
            Agreements with apps
          </h2>
          <p className="text-sm text-muted-foreground">Program agreements apps proposed to your firm. Sign them here once you&apos;ve accepted them.</p>
        </div>
        {data.agreements.length ? (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>App</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Products covered</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.agreements.map((a) => (
                  <TableRow key={a.id} data-firm-agreement={a.id} data-status={a.statusKey}>
                    <TableCell className="whitespace-normal font-medium">{a.appName}</TableCell>
                    <TableCell>{a.kind}</TableCell>
                    <TableCell className="whitespace-normal">
                      {a.status}
                      {a.signatures && <div className="text-xs text-muted-foreground">{a.signatures}</div>}
                    </TableCell>
                    <TableCell className="whitespace-normal">{a.products.join(", ") || "—"}</TableCell>
                    <TableCell>
                      <AgreementRowActions agreementId={a.id} esign={a.esign} statusKey={a.statusKey} side="counterparty" onChanged={onChanged} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No agreements with apps yet.</p>
        )}
      </section>
      <section className="flex flex-col gap-3" aria-labelledby="firm-templates">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="firm-templates" className="text-base font-semibold">
              Agreement templates
            </h2>
            <p className="text-sm text-muted-foreground">Your firm&apos;s program agreement, by licence. The newest version of each is used.</p>
          </div>
          <Button size="sm" onClick={() => setUploading(true)} data-upload-template>
            <FilePlus2 /> Upload agreement template
          </Button>
        </div>
        {retireError && (
          <p role="alert" className="text-sm text-destructive">
            {retireError}
          </p>
        )}
        {data.templates.length ? (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Attached to</TableHead>
                  <TableHead>File</TableHead>
                  <TableHead>SHA-256</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Uploaded</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.templates.map((t) => (
                  <TableRow key={t.id} data-template={t.id} data-active={t.active}>
                    <TableCell className="whitespace-normal font-medium">
                      {t.name}
                      {t.notes && <div className="text-xs text-muted-foreground">{t.notes}</div>}
                    </TableCell>
                    <TableCell className="tabular-nums">{t.version}</TableCell>
                    <TableCell>{t.attachedTo}</TableCell>
                    <TableCell className="whitespace-normal">{t.file ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs" title={t.sha256 ?? undefined}>
                      {t.sha256 ? `${t.sha256.slice(0, 12)}…` : "—"}
                    </TableCell>
                    <TableCell>{t.active ? "In use" : "Retired"}</TableCell>
                    <TableCell className="text-xs tabular-nums">{when(t.createdAt)}</TableCell>
                    <TableCell>
                      {t.active ? (
                        <Button size="sm" variant="outline" onClick={() => void retire(t.id)} data-retire-template={t.id}>
                          Retire
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" data-no-templates>
            No templates yet. Upload your firm&apos;s program agreement so apps can sign it.
          </p>
        )}
      </section>
      <UploadTemplateSheet licences={data.licences} open={uploading} onClose={() => setUploading(false)} onDone={() => onChanged?.()} fetcher={fetcher} />
    </div>
  )
}
