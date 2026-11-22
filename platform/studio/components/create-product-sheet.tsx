"use client"

// New app's Create product: create_product's inputs as one form in a sheet, opened from the composer's
// Products picker, the Products tab's toolbar and /create-product. The id is derived from the name
// until it's edited, and checked with create_product's own rule. Sale and repackaging name the
// published products they build on. Key features, optional, wait under More. Creating makes a draft
// (POST /api/products): it shows in the list as Draft, to Test and Publish from its row.
import { ChevronDown } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import {
  countryOf,
  createProduct,
  flagEmoji,
  HORIZONS,
  isPickable,
  LIQUIDITY,
  NewProductRequest,
  PRODUCT_ACTIONS,
  PRODUCT_LINES,
  PRODUCT_SLUG,
  RETURN_TYPES,
  RISK_LEVELS,
  SLUG_HINT,
  slugFromName,
  type Category,
  type Region,
  type StudioProduct,
} from "@/lib/products"
import { cn } from "@/lib/utils"

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
const areaClass = "rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
const words = (v: string) => v.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
const ACTION_LABELS: Record<(typeof PRODUCT_ACTIONS)[number], string> = { issuance: "Issuance", sale: "Sale", repackaging: "Repackaging" }

type Options = { regions: Region[]; categories: Category[] }
const regionLabel = (r: Region) => {
  const code = countryOf(r.code)
  return code ? `${flagEmoji(code)} ${r.name}` : r.name
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={cn("flex flex-col gap-1 text-sm", wide && "sm:col-span-2")}>
      {label}
      {children}
    </label>
  )
}

function Choice<T extends string>({ label, value, onChange, choices, name, wide }: { label: string; value: string; onChange: (v: T) => void; choices: readonly { value: T; label: string }[]; name: string; wide?: boolean }) {
  return (
    <Field label={label} wide={wide}>
      <select className={selectClass} value={value} onChange={(e) => onChange(e.target.value as T)} aria-label={label} name={name}>
        <option value="" disabled>
          Choose…
        </option>
        {choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    </Field>
  )
}
const enumChoices = <T extends string>(values: readonly T[]) => values.map((v) => ({ value: v, label: words(v) }))

export function CreateProductSheet({
  open,
  onOpenChange,
  products,
  onCreated,
  fetcher = (...a) => fetch(...a),
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  // What sale and repackaging can build on: the published products listed.
  products: StudioProduct[] | null
  onCreated: (product: StudioProduct) => void
  fetcher?: typeof fetch
}) {
  const [options, setOptions] = useState<Options | null>(null)
  const [name, setName] = useState("")
  const [id, setId] = useState("")
  const [idEdited, setIdEdited] = useState(false)
  const [line, setLine] = useState("")
  const [region, setRegion] = useState("")
  const [category, setCategory] = useState("")
  const [regulator, setRegulator] = useState("")
  const [action, setAction] = useState<(typeof PRODUCT_ACTIONS)[number]>("issuance")
  const [underlying, setUnderlying] = useState<string[]>([])
  const [risk, setRisk] = useState("")
  const [liquidity, setLiquidity] = useState("")
  const [horizon, setHorizon] = useState("")
  const [returnType, setReturnType] = useState("")
  const [description, setDescription] = useState("")
  const [features, setFeatures] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Mynt's regions and categories, once the sheet first opens.
  useEffect(() => {
    if (!open || options) return
    let live = true
    void (async () => {
      const res = await fetcher("/api/products/options", { cache: "no-store" }).catch(() => null)
      const data = res?.ok ? ((await res.json().catch(() => null)) as Options | null) : null
      if (live) setOptions({ regions: data?.regions ?? [], categories: data?.categories ?? [] })
    })()
    return () => {
      live = false
    }
  }, [open, options, fetcher])

  const slug = idEdited ? id : slugFromName(name)
  const slugError = slug && !PRODUCT_SLUG.test(slug) ? SLUG_HINT : null
  const categories = useMemo(() => (options?.categories ?? []).filter((c) => !line || !c.productLines.length || c.productLines.includes(line)), [options, line])
  const regulators = options?.regions.find((r) => r.code === region)?.regulators ?? []
  const bases = (products ?? []).filter(isPickable)
  const request = {
    id: slug,
    name: name.trim(),
    product_line: line,
    category: category.trim(),
    region: region.trim(),
    action,
    underlying_product_ids: action === "issuance" ? [] : underlying,
    risk_level: risk,
    liquidity,
    typical_horizon: horizon,
    return_type: returnType,
    regulator: regulator.trim(),
    description: description.trim(),
    key_features: features
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean),
  }

  const reset = () => {
    setName("")
    setId("")
    setIdEdited(false)
    setLine("")
    setRegion("")
    setCategory("")
    setRegulator("")
    setAction("issuance")
    setUnderlying([])
    setRisk("")
    setLiquidity("")
    setHorizon("")
    setReturnType("")
    setDescription("")
    setFeatures("")
    setError(null)
  }

  const submit = async () => {
    if (busy) return
    const parsed = NewProductRequest.safeParse(request)
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Check what you entered.")
    setBusy(true)
    setError(null)
    const result = await createProduct(parsed.data, fetcher)
    setBusy(false)
    if (!result.ok) return setError(result.message)
    onCreated(result.data.product)
    reset()
    onOpenChange(false)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" aria-describedby={undefined} data-create-product-sheet>
        <SheetHeader>
          <SheetTitle>Create product</SheetTitle>
        </SheetHeader>
        <form
          className="grid gap-3 px-4 pb-6 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
          data-form="create-product"
        >
          <Field label="Name" wide>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} aria-label="Name" />
          </Field>
          <Field label="Product id" wide>
            <Input
              value={slug}
              onChange={(e) => {
                setIdEdited(true)
                setId(e.target.value)
              }}
              maxLength={80}
              aria-label="Product id"
              aria-invalid={Boolean(slugError)}
              className="font-mono"
              data-product-slug
            />
            {slugError && (
              <span className="text-xs text-destructive" data-slug-error>
                {slugError}
              </span>
            )}
          </Field>
          <Choice
            label="Product line"
            name="product_line"
            value={line}
            onChange={(v) => {
              setLine(v)
              setCategory("")
            }}
            choices={enumChoices(PRODUCT_LINES)}
          />
          {options?.regions.length ? (
            <Choice
              label="Jurisdiction"
              name="region"
              value={region}
              onChange={(v) => {
                setRegion(v)
                setRegulator("")
              }}
              choices={options.regions.map((r) => ({ value: r.code, label: regionLabel(r) }))}
            />
          ) : (
            <Field label="Jurisdiction">
              <Input value={region} onChange={(e) => setRegion(e.target.value.toUpperCase())} maxLength={6} placeholder="US" aria-label="Jurisdiction" />
            </Field>
          )}
          {categories.length ? (
            <Choice label="Category" name="category" value={category} onChange={setCategory} choices={categories.map((c) => ({ value: c.id, label: c.name }))} />
          ) : (
            <Field label="Category">
              <Input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={120} aria-label="Category" />
            </Field>
          )}
          {regulators.length ? (
            <Choice label="Regulator" name="regulator" value={regulator} onChange={setRegulator} choices={regulators.map((r) => ({ value: r, label: r }))} />
          ) : (
            <Field label="Regulator">
              <Input value={regulator} onChange={(e) => setRegulator(e.target.value)} maxLength={200} aria-label="Regulator" />
            </Field>
          )}
          <Choice label="Action" name="action" value={action} onChange={setAction} choices={PRODUCT_ACTIONS.map((a) => ({ value: a, label: ACTION_LABELS[a] }))} wide />
          {action !== "issuance" && (
            <fieldset className="flex flex-col gap-1 text-sm sm:col-span-2" data-underlying>
              <legend className="mb-1">Underlying products</legend>
              {bases.length ? (
                <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border p-2">
                  {bases.map((p) => (
                    <label key={p.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={underlying.includes(p.id)}
                        onChange={() => setUnderlying((u) => (u.includes(p.id) ? u.filter((x) => x !== p.id) : [...u, p.id]))}
                        data-underlying-option={p.id}
                      />
                      <span className="truncate">{p.name}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <span className="text-muted-foreground">No published products to build on.</span>
              )}
            </fieldset>
          )}
          <Choice label="Risk level" name="risk_level" value={risk} onChange={setRisk} choices={enumChoices(RISK_LEVELS)} />
          <Choice label="Liquidity" name="liquidity" value={liquidity} onChange={setLiquidity} choices={enumChoices(LIQUIDITY)} />
          <Choice label="Typical horizon" name="typical_horizon" value={horizon} onChange={setHorizon} choices={enumChoices(HORIZONS)} />
          <Choice label="Return type" name="return_type" value={returnType} onChange={setReturnType} choices={enumChoices(RETURN_TYPES)} />
          <Field label="Description" wide>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} rows={3} className={areaClass} aria-label="Description" />
          </Field>
          <Collapsible className="sm:col-span-2" data-more>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="group h-8 px-2">
                More
                <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <Field label="Key features (one per line)">
                <textarea value={features} onChange={(e) => setFeatures(e.target.value)} rows={3} className={areaClass} aria-label="Key features" />
              </Field>
            </CollapsibleContent>
          </Collapsible>
          {error && (
            <p role="alert" className="text-sm text-destructive sm:col-span-2" data-create-product-error>
              {error}
            </p>
          )}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy || Boolean(slugError)} data-submit="create-product">
              {busy ? "Creating…" : "Create product"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
