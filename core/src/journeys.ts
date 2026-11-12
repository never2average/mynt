import { z } from "zod";
import type { ContractAction, DeveloperContract } from "./contract.js";
import { CAPTURE_METHODS, DATA_DICTIONARY, isDataField } from "./data-dictionary.js";

// Journeys: how an app walks a customer through a product, as a declarative spec rather than code.
// A journey is a graph of steps (screens of elements, consent captures, provider-hosted actions, waits for
// lifecycle events) built on one version of a product's developer contract. Mynt checks every path through
// it: consent before personal data, the product's documents before any hosted action, every field an
// action needs collected before it and none it doesn't, sensitive fields only in secure inputs, every step
// reachable and every path ending. Each problem names the step and how to fix it.

// Consent purposes Mynt itself defines (on top of each contract's own).
export const PLATFORM_PURPOSES = ["service_messages"] as const;

const Id = z.string().regex(/^[a-z][a-z0-9_]*$/, "Use a snake_case id");
const Condition = z.object({ segment: z.string().optional(), field: z.string().optional(), equals: z.union([z.string(), z.number(), z.boolean()]).optional() }).strict();
const Element = z.discriminatedUnion("type", [
  z.object({ type: z.literal("offer_card"), segment: z.string().optional() }).strict(),
  z.object({ type: z.literal("disclosure"), document: z.string() }).strict(),
  z
    .object({
      type: z.literal("field"),
      field: z.string(),
      capture: z.enum(CAPTURE_METHODS).default("typed"),
      required: z.boolean().default(true),
      show_if: Condition.optional(),
    })
    .strict(),
  z.object({ type: z.literal("text"), text: z.string().max(2000) }).strict(),
  z.object({ type: z.literal("outcome"), outcome: z.string().max(100) }).strict(),
]);
const Step = z
  .object({
    id: Id,
    title: z.string().max(200).optional(),
    screen: z.array(Element).max(30).optional(),
    capture_consent: z.string().optional().describe("A consent purpose from the contract (or service_messages)"),
    action: z.string().optional().describe("A provider-hosted client action from the contract"),
    await_event: z.string().optional().describe("A lifecycle event from the contract"),
    timeout: z.string().regex(/^P/).optional(),
    next: z.string().optional(),
    on: z.record(z.string(), z.string()).optional().describe("Outcome to next step, e.g. { completed: 'done', failed: 'retry' }"),
  })
  .strict();
export const JourneySchema = z
  .object({
    journey: Id,
    title: z.string().max(200).optional(),
    built_on: z.object({ product_id: z.string(), contract_version: z.number().int().min(1) }).strict(),
    steps: z.array(Step).min(1).max(60),
    resume: z
      .object({ channels: z.array(z.enum(["email", "whatsapp", "sms", "push"])).min(1), after: z.string().regex(/^P/), consent_purpose: z.string() })
      .strict()
      .optional(),
  })
  .strict();
export type Journey = z.infer<typeof JourneySchema>;
type JStep = Journey["steps"][number];

const kindOf = (s: JStep) => [s.screen ? "screen" : null, s.capture_consent ? "consent" : null, s.action ? "action" : null, s.await_event ? "await" : null].filter(Boolean) as string[];
const successors = (s: JStep) => [...new Set([...(s.next ? [s.next] : []), ...Object.values(s.on ?? {})])];
const hosted = (c: DeveloperContract) => c.actions.filter((a) => (a.surface === "client" || a.surface === "either") && a.flow === "hosted");

export interface JourneyCheck {
  valid: boolean;
  errors: string[];
  warnings: string[];
  paths: string[][];
}

// Every path from the first step to an end (cycles are followed once), for simulation.
export function journeyPaths(j: Journey, limit = 50): string[][] {
  const byId = new Map(j.steps.map((s) => [s.id, s]));
  const out: string[][] = [];
  const walk = (id: string, path: string[]) => {
    if (out.length >= limit) return;
    const s = byId.get(id);
    if (!s) return;
    const next = successors(s).filter((n) => !path.includes(n));
    if (!successors(s).length || !next.length) {
      out.push([...path, id]);
      return;
    }
    for (const n of next) walk(n, [...path, id]);
  };
  if (j.steps.length) walk(j.steps[0].id, []);
  return out;
}

export function checkJourney(j: Journey, contract: DeveloperContract): JourneyCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (j.built_on.product_id !== contract.product_id) errors.push(`built_on.product_id must be '${contract.product_id}'`);
  if (j.built_on.contract_version !== contract.version)
    errors.push(`built on contract version ${j.built_on.contract_version}, but the live version is ${contract.version}: re-check the journey against it and update built_on`);

  const byId = new Map<string, JStep>();
  const before = errors.length;
  for (const s of j.steps) {
    if (byId.has(s.id)) errors.push(`step '${s.id}' is defined twice`);
    byId.set(s.id, s);
    const kinds = kindOf(s);
    if (kinds.length !== 1) errors.push(`step '${s.id}' must do exactly one thing (a screen, a consent capture, a hosted action or a wait), not ${kinds.join(" + ") || "nothing"}`);
    for (const n of successors(s)) if (!j.steps.some((x) => x.id === n)) errors.push(`step '${s.id}' goes to '${n}', which isn't a step`);
    if (s.on && s.next) errors.push(`step '${s.id}': use next or on, not both`);
  }
  // A broken graph makes the path checks noise; other problems are all reported together.
  if (errors.length > before) return { valid: false, errors, warnings, paths: [] };

  const purposes = new Set<string>([...contract.consent_purposes, ...PLATFORM_PURPOSES]);
  const actions = new Map(hosted(contract).map((a) => [a.id, a]));
  const segments = new Set(contract.offers.map((o) => o.segment_id));
  const events = new Set(contract.events.map((e) => e.type));
  const documents = Object.keys(contract.documents);

  // Reachable from the first step, and able to reach an end.
  const first = j.steps[0].id;
  const reach = new Set<string>([first]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of [...reach]) for (const n of successors(byId.get(id)!)) if (!reach.has(n)) (reach.add(n), (changed = true));
  }
  for (const s of j.steps) if (!reach.has(s.id)) errors.push(`step '${s.id}' can't be reached from '${first}'`);
  const ends = new Set(j.steps.filter((s) => !successors(s).length).map((s) => s.id));
  if (!ends.size) errors.push("the journey never ends: give it a step with no next");
  const canEnd = new Set(ends);
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of j.steps) if (!canEnd.has(s.id) && successors(s).some((n) => canEnd.has(n))) (canEnd.add(s.id), (changed = true));
  }
  for (const s of j.steps) if (reach.has(s.id) && !canEnd.has(s.id)) errors.push(`from step '${s.id}' the journey can never end (a loop with no way out)`);

  // What every path has surely done before each step: consents captured, fields collected, documents shown.
  type Facts = { consents: Set<string>; fields: Set<string>; docs: Set<string> };
  const gen = (s: JStep): Facts => ({
    consents: new Set(s.capture_consent ? [s.capture_consent] : []),
    fields: new Set((s.screen ?? []).filter((e) => e.type === "field" && e.required && !e.show_if).map((e) => (e as { field: string }).field)),
    docs: new Set((s.screen ?? []).filter((e) => e.type === "disclosure").map((e) => (e as { document: string }).document)),
  });
  const preds = new Map<string, string[]>(j.steps.map((s) => [s.id, []]));
  for (const s of j.steps) for (const n of successors(s)) preds.get(n)!.push(s.id);
  const empty = (): Facts => ({ consents: new Set(), fields: new Set(), docs: new Set() });
  const ALL = Symbol("all");
  const outOf = new Map<string, Facts | typeof ALL>(j.steps.map((s) => [s.id, ALL]));
  const inOf = new Map<string, Facts>();
  const meet = (a: Facts | typeof ALL, b: Facts | typeof ALL): Facts | typeof ALL =>
    a === ALL ? b : b === ALL ? a : { consents: new Set([...a.consents].filter((x) => b.consents.has(x))), fields: new Set([...a.fields].filter((x) => b.fields.has(x))), docs: new Set([...a.docs].filter((x) => b.docs.has(x))) };
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of j.steps) {
      if (!reach.has(s.id)) continue;
      let inn: Facts | typeof ALL = s.id === first ? empty() : ALL;
      for (const p of preds.get(s.id)!) if (reach.has(p)) inn = s.id === first ? inn : meet(inn, outOf.get(p)!);
      const i = inn === ALL ? empty() : inn;
      const g = gen(s);
      const out: Facts = { consents: new Set([...i.consents, ...g.consents]), fields: new Set([...i.fields, ...g.fields]), docs: new Set([...i.docs, ...g.docs]) };
      const prev = outOf.get(s.id)!;
      if (prev === ALL || prev.consents.size !== out.consents.size || prev.fields.size !== out.fields.size || prev.docs.size !== out.docs.size) {
        outOf.set(s.id, out);
        changed = true;
      }
      inOf.set(s.id, i);
    }
  }

  // Fields some action in this journey actually needs (data minimisation).
  const usedActions = j.steps.map((s) => s.action).filter((a): a is string => Boolean(a));
  const needed = new Set(usedActions.flatMap((a) => (actions.get(a)?.data_requirements ?? []).map((r) => r.field)));
  for (const s of j.steps) {
    const before = inOf.get(s.id) ?? empty();
    for (const e of s.screen ?? []) {
      if (e.type === "offer_card" && e.segment && !segments.has(e.segment)) errors.push(`step '${s.id}': no offer for segment '${e.segment}' (segments: ${[...segments].join(", ")})`);
      if (e.type === "disclosure" && !documents.includes(e.document)) errors.push(`step '${s.id}': '${e.document}' isn't one of the product's documents (${documents.join(", ") || "none"})`);
      if (e.type === "field") {
        const f = DATA_DICTIONARY[e.field];
        if (!isDataField(e.field)) {
          errors.push(`step '${s.id}': '${e.field}' isn't in Mynt's data dictionary`);
          continue;
        }
        if (!f.capture.includes(e.capture)) errors.push(`step '${s.id}': ${e.field} can't be captured by ${e.capture} (allowed: ${f.capture.join(", ")})`);
        if (f.sensitivity === "sensitive" && e.capture === "typed") errors.push(`step '${s.id}': ${e.field} is sensitive: capture it with a secure field (or ${f.capture.filter((c) => c !== "typed").join(", ")}), never a plain input`);
        if (f.sensitivity !== "public" && !before.consents.size && !s.capture_consent)
          errors.push(`step '${s.id}' collects ${e.field} before any consent: move a consent step before it`);
        if (!needed.has(e.field)) errors.push(`step '${s.id}' collects ${e.field}, which no action in this journey needs: drop it`);
      }
    }
    if (s.capture_consent && !purposes.has(s.capture_consent)) errors.push(`step '${s.id}': '${s.capture_consent}' isn't a consent purpose of this product (${[...purposes].join(", ")})`);
    if (s.await_event && !events.has(s.await_event)) errors.push(`step '${s.id}': '${s.await_event}' isn't an event of this product`);
    if (s.action) {
      const a = actions.get(s.action);
      if (!a) {
        errors.push(`step '${s.id}': '${s.action}' isn't a hosted client action of this product (${[...actions.keys()].join(", ") || "none"})`);
        continue;
      }
      if (a.consent_purpose && !before.consents.has(a.consent_purpose)) errors.push(`step '${s.id}' starts ${a.id} before consent '${a.consent_purpose}' is captured on every path: add a consent step before it`);
      for (const d of documents) if (!before.docs.has(d)) errors.push(`step '${s.id}' starts ${a.id} before the '${d}' document is shown on every path: show it earlier`);
      for (const r of (a.data_requirements ?? []) as NonNullable<ContractAction["data_requirements"]>) {
        if (!r.known) warnings.push(`${a.id} sends '${r.field}', which isn't in Mynt's data dictionary: the provider collects it in its own flow`);
        else if (r.sensitivity !== "public" && !before.fields.has(r.field) && !r.capture?.includes("derived"))
          errors.push(`step '${s.id}' starts ${a.id}, which needs ${r.field}, before it's collected on every path: collect it earlier`);
      }
      if (!s.on) warnings.push(`step '${s.id}': handle the hosted flow's outcome with on: { completed, failed }`);
    }
  }
  if (j.resume) {
    if (!purposes.has(j.resume.consent_purpose)) errors.push(`resume: '${j.resume.consent_purpose}' isn't a consent purpose`);
    else if (!j.steps.some((s) => s.capture_consent === j.resume!.consent_purpose)) errors.push(`resume messages need consent '${j.resume.consent_purpose}' captured in the journey`);
  }
  return { valid: errors.length === 0, errors, warnings, paths: errors.length ? [] : journeyPaths(j) };
}

// The minimum compliant journey for a product: offers and documents, each consent, the fields each hosted
// action needs, the action, then done. Developers start here and edit.
export function defaultJourney(contract: DeveloperContract): Journey {
  const steps: JStep[] = [];
  const docs = Object.keys(contract.documents);
  steps.push({ id: "intro", title: "Your options", screen: [{ type: "offer_card" }, ...docs.map((d) => ({ type: "disclosure" as const, document: d }))] });
  for (const p of contract.consent_purposes) steps.push({ id: `consent_${p}`, title: "Your consent", capture_consent: p });
  for (const a of hosted(contract)) {
    const fields = (a.data_requirements ?? []).filter((r) => r.known && r.sensitivity !== "public" && !r.capture?.includes("derived"));
    if (fields.length)
      steps.push({
        id: `details_${a.id}`,
        title: "Your details",
        screen: fields.map((r) => ({
          type: "field" as const,
          field: r.field,
          capture: (r.sensitivity === "sensitive" ? (r.capture?.find((c) => c !== "typed") ?? "secure_field") : (r.capture?.[0] ?? "typed")) as (typeof CAPTURE_METHODS)[number],
          required: true,
        })),
      });
    steps.push({ id: a.id, title: a.name, action: a.id, on: { completed: "__next__", failed: "failed" } });
  }
  steps.push({ id: "done", title: "All set", screen: [{ type: "outcome", outcome: "completed" }] });
  if (steps.some((s) => s.on?.failed)) steps.push({ id: "failed", title: "Something went wrong", screen: [{ type: "outcome", outcome: "failed" }] });
  // Link the steps in order; hosted actions go on to the next step when completed.
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const next = steps.slice(i + 1).find((x) => x.id !== "failed")?.id;
    if (s.id === "done" || s.id === "failed") continue;
    if (s.on) s.on = { ...s.on, completed: next ?? "done" };
    else s.next = next ?? "done";
  }
  return { journey: `${contract.product_id.replace(/[^a-z0-9]+/g, "_")}_default`, title: "Default journey", built_on: { product_id: contract.product_id, contract_version: contract.version }, steps };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// A static outline of the journey for review: each step, what it shows or does, and where it goes.
export function previewJourney(j: Journey, contract: DeveloperContract): string {
  const describe = (s: JStep) => {
    if (s.capture_consent) return `<p>Asks for consent: <strong>${esc(s.capture_consent)}</strong></p>`;
    if (s.action) return `<p>Opens the provider's hosted flow: <strong>${esc(contract.actions.find((a) => a.id === s.action)?.name ?? s.action)}</strong></p>`;
    if (s.await_event) return `<p>Waits for <strong>${esc(s.await_event)}</strong>${s.timeout ? ` (up to ${esc(s.timeout)})` : ""}</p>`;
    return `<ul>${(s.screen ?? [])
      .map((e) =>
        e.type === "field"
          ? `<li>${esc(DATA_DICTIONARY[e.field]?.label ?? e.field)} <small>(${esc(e.capture)}${e.show_if ? ", conditional" : ""})</small></li>`
          : e.type === "disclosure"
            ? `<li>Document: <a href="${esc(contract.documents[e.document] ?? "#")}">${esc(e.document)}</a></li>`
            : e.type === "offer_card"
              ? `<li>Offer${e.segment ? ` for ${esc(e.segment)}` : "s"}</li>`
              : e.type === "outcome"
                ? `<li>Outcome: ${esc(e.outcome)}</li>`
                : `<li>${esc(e.text)}</li>`,
      )
      .join("")}</ul>`;
  };
  const to = (s: JStep) => (s.on ? Object.entries(s.on).map(([k, v]) => `${esc(k)} → ${esc(v)}`).join(", ") : s.next ? `→ ${esc(s.next)}` : "end");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(j.title ?? j.journey)}</title></head><body><h1>${esc(j.title ?? j.journey)}</h1>${j.steps
    .map((s) => `<section id="${esc(s.id)}"><h2>${esc(s.title ?? s.id)}</h2>${describe(s)}<p><small>${to(s)}</small></p></section>`)
    .join("")}</body></html>`;
}
