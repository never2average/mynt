import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { APP_KINDS_DIR, appKinds, type AppKind } from "./app-kinds.js";
import { PRODUCT_LINES } from "./catalog.js";
import type { Db } from "./db.js";
import type { Store, User } from "./store.js";

// New app's ideas: specific apps someone could build on an app kind (app-kinds.ts), each named by the problem it
// solves ("Roommates chase each other for their share of rent and bills"), with a one-line pitch saying what the
// app does about it and a goal to start the build from. They are rows in Postgres (financial_products.app_ideas,
// app-ideas-schema.ts) that admins keep with create_app_idea, update_app_idea and retire_app_idea; developers read
// the active ones with list_app_ideas, and the studio shows them as chips and Templates rows. The ones Mynt ships
// are in workspaces/coding-build/templates/ideas.seed.json, added only when an admin runs seed_app_ideas: never on
// startup, and never over a row an admin has edited or retired.

export const APP_IDEAS_SEED_PATH = join(APP_KINDS_DIR, "..", "ideas.seed.json");

// The product lines an idea may build on: the ones some app kind declares (the kinds follow the products Mynt
// can build on), and of those only its own kind's.
export const ideaLines = (kinds: readonly AppKind[] = appKinds()): string[] => [...new Set(kinds.flatMap((k) => k.product_lines))].sort();

export const IDEA_ID = /^[a-z][a-z0-9-]{1,39}$/;
export const CATEGORY = /^[a-z][a-z0-9_]{1,39}$/;
export const PRODUCT_NAME_MAX = 60;
export const PROBLEM_MAX = 80;
export const PITCH_MAX = 120;
export const GOAL_MIN = 40;
export const GOAL_MAX = 1200;

// What an idea mustn't be about (lending, insurance, trading, cards: nothing Mynt's ideas build on), and what it
// mustn't call the people it serves. Factual words for the products ideas build on (interest, rate, matures,
// retirement, fund, inflation) are fine.
export const UNSUPPORTED_WORDS =
  /\b(loans?|lend\w*|borrow\w*|credit|bnpl|mortgages?|insur\w*|invest\w*|stocks?|bonds?|mutual funds?|index funds?|etfs?|brokerage|dividends?|cards?|merchants?|shopkeepers?|sellers?|storefronts?|crypto trading|trading)\b/i;
// What a finance app must never promise, project or advise: earnings, yields, returns, guarantees, beating
// inflation, a percentage, advice. The app shows information, so "not advice" is the one way the word may appear.
export const PROMISE_WORDS = new RegExp(
  [
    String.raw`\b(earn\w*|yields?|apy|returns?|profits?|gains?|guarantee\w*|risk[- ]free|no[- ]risk|safe bet|can'?t lose|never lose|projected|projections?|forecast\w*|recommend\w*)\b`,
    String.raw`\b(beats?|beating|outpac\w*|outrun\w*|stays? ahead of|protects? (you|your \w+) from) inflation\b`,
    String.raw`\binflation[- ]proof\b`,
    String.raw`\d+(\.\d+)?\s*%`,
    String.raw`(?<!\bnot )\badvi(ce|se|ses|sed|sing|sors?)\b`,
  ].join("|"),
  "i",
);
const HOSTNAME_LIKE = /\b[a-z0-9-]+\.[a-z]{2,}\b/i;
const SDK_CALL = /\b[a-z]+[A-Z]\w*\b/g;

export interface AppIdeaFields {
  id: string;
  kind: string;
  problem: string;
  pitch: string;
  goal: string;
  product_lines: string[];
  // The product categories in those lines it's for (deposits, retirement, ...), when it's narrower than its lines.
  categories?: string[];
  // Words from the names of the products it's for ("Money Market Account"), when a category is still too wide:
  // the studio picks the published products in its lines and categories whose names contain one of them.
  product_names?: string[];
  sort?: number;
}
export interface AppIdea extends Required<AppIdeaFields> {
  status: "active" | "retired";
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

// Everything wrong with an idea, in plain words (none: it's good). The same rules for an admin's edit and the seed.
export function appIdeaErrors(idea: AppIdeaFields, kinds: readonly AppKind[] = appKinds()): string[] {
  const errors: string[] = [];
  const label = `idea '${idea.id}'`;
  if (!IDEA_ID.test(idea.id)) errors.push(`${label}: the id is 2 to 40 lowercase letters, digits and dashes, starting with a letter`);
  const kind = kinds.find((k) => k.id === idea.kind);
  if (!kind) errors.push(`${label}: no app kind '${idea.kind}' (list_app_kinds lists them: ${kinds.map((k) => k.id).join(", ")})`);
  const line = (name: string, text: string, min: number, max: number) => {
    const t = text.trim();
    if (t.length < min || t.length > max) errors.push(`${label}: the ${name} is ${min} to ${max} characters, not ${t.length}`);
    if (/[\r\n]/.test(text)) errors.push(`${label}: the ${name} is one line`);
  };
  line("problem", idea.problem, 10, PROBLEM_MAX);
  line("pitch", idea.pitch, 10, PITCH_MAX);
  const goal = idea.goal.trim().length;
  if (goal < GOAL_MIN || goal > GOAL_MAX) errors.push(`${label}: the goal is ${GOAL_MIN} to ${GOAL_MAX} characters, not ${goal}`);
  if (!idea.product_lines.length) errors.push(`${label}: name at least one product line`);
  if (new Set(idea.product_lines).size !== idea.product_lines.length) errors.push(`${label}: a product line is listed twice`);
  const lines = ideaLines(kinds);
  for (const l of idea.product_lines) {
    if (!lines.includes(l)) errors.push(`${label}: '${l}' isn't a product line any app kind builds on (${lines.join(", ")})`);
    else if (kind && !kind.product_lines.includes(l as never)) errors.push(`${label}: '${l}' isn't one of the ${kind.id} kind's product lines (${kind.product_lines.join(", ")})`);
  }
  const categories = idea.categories ?? [];
  if (new Set(categories).size !== categories.length) errors.push(`${label}: a category is listed twice`);
  for (const c of categories) {
    if (!CATEGORY.test(c)) errors.push(`${label}: '${c}' isn't a category id (lowercase letters, digits and underscores)`);
    else if (kind?.categories && !kind.categories.includes(c)) errors.push(`${label}: '${c}' isn't one of the ${kind.id} kind's categories (${kind.categories.join(", ")})`);
  }
  const names = idea.product_names ?? [];
  if (names.length > 8) errors.push(`${label}: at most 8 product names`);
  for (const n of names)
    if (n.trim().length < 2 || n.trim().length > PRODUCT_NAME_MAX || /[\r\n]/.test(n)) errors.push(`${label}: a product name is 2 to ${PRODUCT_NAME_MAX} characters on one line`);
  for (const [name, text] of [["problem", idea.problem], ["pitch", idea.pitch], ["goal", idea.goal], ...names.map((n) => ["product name", n] as const)] as const) {
    const word = text.match(UNSUPPORTED_WORDS)?.[0];
    if (word) errors.push(`${label}: the ${name} says '${word}', which no app kind builds on, or which a finance app mustn't call the people it serves`);
    const promise = text.match(PROMISE_WORDS)?.[0];
    if (promise) errors.push(`${label}: the ${name} says '${promise}', which promises, projects or advises what a finance app mustn't (describe the product's terms as it states them)`);
    if (HOSTNAME_LIKE.test(text)) errors.push(`${label}: the ${name} has a web address or file name in it`);
  }
  if (kind) {
    const calls = new Set([...kind.sdk_calls.server, ...kind.sdk_calls.browser]);
    for (const name of new Set(idea.goal.match(SDK_CALL) ?? []))
      if (!calls.has(name)) errors.push(`${label}: the goal names ${name}, which isn't one of the ${kind.id} kind's SDK calls`);
    if (kind.product_lines.includes("exchange") && !/dollars only, never crypto/.test(idea.goal))
      errors.push(`${label}: a stablecoin-settled app's goal says it shows "dollars only, never crypto"`);
  }
  return errors;
}

export class AppIdeaError extends Error {}

const COLUMNS = "id, kind, problem, pitch, goal, product_lines, categories, product_names, status, sort, created_at, updated_at, created_by";
const iso = (v: unknown) => new Date(v as string).toISOString();
const toIdea = (r: Record<string, unknown>): AppIdea => ({
  id: r.id as string,
  kind: r.kind as string,
  problem: r.problem as string,
  pitch: r.pitch as string,
  goal: r.goal as string,
  product_lines: [...(r.product_lines as string[])],
  categories: [...((r.categories as string[] | null) ?? [])],
  product_names: [...((r.product_names as string[] | null) ?? [])],
  status: r.status as AppIdea["status"],
  sort: Number(r.sort),
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
  created_by: (r.created_by as string | null) ?? null,
});
const tidy = (f: AppIdeaFields): AppIdeaFields => ({ ...f, problem: f.problem.trim(), pitch: f.pitch.trim(), goal: f.goal.trim(), categories: f.categories ?? [], product_names: (f.product_names ?? []).map((n) => n.trim()) });
const check = (f: AppIdeaFields, kinds?: readonly AppKind[]) => {
  const errors = appIdeaErrors(f, kinds);
  if (errors.length) throw new AppIdeaError(errors.join("; "));
};

// Ideas by kind (in the kinds' order of ids), then their sort, then id. Active ones unless retired ones are asked for.
export async function listAppIdeas(db: Pick<Db, "query">, opts: { kind?: string; includeRetired?: boolean } = {}): Promise<AppIdea[]> {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM financial_products.app_ideas
     WHERE ($1::text IS NULL OR kind = $1) AND ($2::boolean OR status = 'active')
     ORDER BY kind, sort, id`,
    [opts.kind ?? null, opts.includeRetired ?? false],
  );
  return rows.map(toIdea);
}

export async function getAppIdea(db: Pick<Db, "query">, id: string): Promise<AppIdea | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM financial_products.app_ideas WHERE id = $1`, [id]);
  return rows[0] ? toIdea(rows[0]) : null;
}

export async function createAppIdea(db: Pick<Db, "query">, fields: AppIdeaFields, actorId: string | null, kinds?: readonly AppKind[]): Promise<AppIdea> {
  const f = tidy(fields);
  check(f, kinds);
  const { rows } = await db.query(
    `INSERT INTO financial_products.app_ideas (id, kind, problem, pitch, goal, product_lines, categories, product_names, sort, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING RETURNING ${COLUMNS}`,
    [f.id, f.kind, f.problem, f.pitch, f.goal, f.product_lines, f.categories ?? [], f.product_names ?? [], f.sort ?? 0, actorId],
  );
  if (!rows[0]) throw new AppIdeaError(`There's already an idea '${f.id}'; change it with update_app_idea`);
  return toIdea(rows[0]);
}

export type AppIdeaPatch = Partial<Omit<AppIdeaFields, "id">> & { status?: AppIdea["status"] };

// Changes some fields; the idea as it would then be is checked whole (a new kind needs lines of its own).
export async function updateAppIdea(db: Pick<Db, "query">, id: string, patch: AppIdeaPatch, kinds?: readonly AppKind[]): Promise<AppIdea> {
  const current = await getAppIdea(db, id);
  if (!current) throw new AppIdeaError(`No idea '${id}'; list_app_ideas lists them`);
  const next = tidy({ ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), id });
  check(next, kinds);
  const { rows } = await db.query(
    `UPDATE financial_products.app_ideas SET kind = $2, problem = $3, pitch = $4, goal = $5, product_lines = $6, categories = $7, product_names = $8, sort = $9, status = $10, updated_at = now()
     WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, next.kind, next.problem, next.pitch, next.goal, next.product_lines, next.categories ?? [], next.product_names ?? [], next.sort ?? 0, patch.status ?? current.status],
  );
  return toIdea(rows[0]);
}

export async function retireAppIdea(db: Pick<Db, "query">, id: string): Promise<AppIdea> {
  const { rows } = await db.query(
    `UPDATE financial_products.app_ideas SET status = 'retired', updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
    [id],
  );
  if (!rows[0]) throw new AppIdeaError(`No idea '${id}'; list_app_ideas lists them`);
  return toIdea(rows[0]);
}

// The shipped ideas, every one checked: a bad one is a bug in the repository, so it throws.
export function seedIdeas(path = APP_IDEAS_SEED_PATH, kinds?: readonly AppKind[]): AppIdeaFields[] {
  const data = JSON.parse(readFileSync(path, "utf8")) as { ideas?: AppIdeaFields[] };
  const ideas = (data.ideas ?? []).map(tidy);
  const errors = ideas.flatMap((i) => appIdeaErrors(i, kinds));
  const ids = ideas.map((i) => i.id);
  for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) errors.push(`idea '${id}' is in the seed twice`);
  if (errors.length) throw new Error(`Bad app idea seed: ${errors.join("; ")}`);
  return ideas;
}

// Adds the shipped ideas that aren't there yet. One that is (edited, retired or untouched) is left exactly as it is.
export async function seedAppIdeas(db: Pick<Db, "query">, actorId: string | null, ideas: AppIdeaFields[] = seedIdeas()): Promise<{ inserted: string[]; kept: string[] }> {
  const inserted: string[] = [];
  const kept: string[] = [];
  for (const f of ideas) {
    const { rows } = await db.query(
      `INSERT INTO financial_products.app_ideas (id, kind, problem, pitch, goal, product_lines, categories, product_names, sort, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [f.id, f.kind, f.problem, f.pitch, f.goal, f.product_lines, f.categories ?? [], f.product_names ?? [], f.sort ?? 0, actorId],
    );
    (rows.length ? inserted : kept).push(f.id);
  }
  return { inserted, kept };
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });
const forDeveloper = ({ id, kind, problem, pitch, goal, product_lines, categories, product_names }: AppIdea) => ({ id, kind, problem, pitch, goal, product_lines, categories, product_names });
const refusal = (e: unknown) => {
  if (e instanceof AppIdeaError) return fail(e.message);
  throw e;
};

const kindId = z.string().regex(IDEA_ID).describe("An app kind's id (list_app_kinds)");
const ideaFields = {
  problem: z.string().min(10).max(PROBLEM_MAX).describe("The label: who has the problem and what it is, in plain words (\"Roommates chase each other for their share of rent and bills\"). No product names"),
  pitch: z.string().min(10).max(PITCH_MAX).describe("One line: what the app does about the problem"),
  goal: z.string().min(GOAL_MIN).max(GOAL_MAX).describe("The goal the build starts from, which the developer edits"),
  product_lines: z.array(z.enum(PRODUCT_LINES)).min(1).describe("Some or all of the kind's product lines"),
  categories: z.array(z.string().regex(CATEGORY)).max(8).optional().describe("Optional: the product categories in those lines the idea is for (deposits, retirement, ...; within the kind's own, if it lists some). The studio picks the published products in them"),
  product_names: z.array(z.string().min(2).max(PRODUCT_NAME_MAX)).max(8).optional().describe("Optional: words from the names of the products it's for (\"Money Market Account\"), when a category is still too wide. The studio picks the published products in the idea's lines and categories whose names contain one"),
  sort: z.number().int().min(0).max(100000).optional().describe("Order within the kind, lowest first (default 0)"),
};

export function registerAppIdeaTools(server: McpServer, store: Store, opts: { admin?: boolean } = {}) {
  server.registerTool(
    "list_app_ideas",
    {
      title: "App ideas",
      description:
        "Developer: specific finance apps to start from, each on an app kind (list_app_kinds): the problem it solves as its label, a one-line pitch saying what the app does about it, a goal to start the build from and edit, the kind's product lines it builds on and, optionally, the product categories in them it's for. Pass the idea's kind as start_build's kind and its goal as the goal. Only active ideas, unless an admin passes include_retired.",
      inputSchema: {
        kind: kindId.optional().describe("Only this kind's ideas"),
        include_retired: z.boolean().optional().describe("Admins only: retired ideas too, with each idea's status and history"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ kind, include_retired }) => {
      const ideas = await listAppIdeas(store.db, { kind, includeRetired: Boolean(opts.admin && include_retired) });
      return json({
        ideas: opts.admin && include_retired ? ideas : ideas.map(forDeveloper),
        ...(ideas.length ? {} : { note: kind ? `No ideas on ${kind} yet` : "No ideas yet: an admin adds them with seed_app_ideas or create_app_idea" }),
      });
    },
  );
}

export function registerAppIdeaAdminTools(server: McpServer, store: Store, user: User) {
  server.registerTool(
    "create_app_idea",
    {
      title: "Add an app idea",
      description:
        "Admin: add a specific app idea on an app kind, offered on New app. Its label is a plain problem statement (who, and the problem), the pitch says what the app does about it, and the goal is where the build starts. Refused if the kind isn't there, a line or category isn't the kind's, the text is about lending, insurance, investing, trading or cards, promises or projects earnings, yields, returns or guarantees, gives advice ('not advice' is fine), or frames users as sellers of goods. Factual words about the products (interest, rate, matures, retirement, fund) are fine.",
      inputSchema: { id: z.string().regex(IDEA_ID).describe("A short slug, unique across every idea"), kind: kindId, ...ideaFields },
    },
    async (args) => {
      try {
        const idea = await createAppIdea(store.db, args, user.id);
        await store.audit(user.id, "create_app_idea", idea.id, { kind: idea.kind, problem: idea.problem });
        return json({ idea });
      } catch (e) {
        return refusal(e);
      }
    },
  );

  server.registerTool(
    "update_app_idea",
    {
      title: "Change an app idea",
      description:
        "Admin: change some of an app idea's fields (the ones you leave out stay). The idea as it would then be is checked whole, as create_app_idea checks it. status 'active' brings back a retired idea.",
      inputSchema: {
        id: z.string().regex(IDEA_ID),
        kind: kindId.optional(),
        problem: ideaFields.problem.optional(),
        pitch: ideaFields.pitch.optional(),
        goal: ideaFields.goal.optional(),
        product_lines: ideaFields.product_lines.optional(),
        categories: ideaFields.categories,
        product_names: ideaFields.product_names,
        sort: ideaFields.sort,
        status: z.enum(["active", "retired"]).optional(),
      },
    },
    async ({ id, ...patch }) => {
      try {
        const before = await getAppIdea(store.db, id);
        const idea = await updateAppIdea(store.db, id, patch);
        await store.audit(user.id, "update_app_idea", id, { changed: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined), before: before && forDeveloper(before) });
        return json({ idea });
      } catch (e) {
        return refusal(e);
      }
    },
  );

  server.registerTool(
    "retire_app_idea",
    {
      title: "Retire an app idea",
      description: "Admin: stop offering an app idea on New app. The row stays (update_app_idea with status 'active' brings it back).",
      inputSchema: { id: z.string().regex(IDEA_ID) },
    },
    async ({ id }) => {
      try {
        const idea = await retireAppIdea(store.db, id);
        await store.audit(user.id, "retire_app_idea", id, {});
        return json({ idea });
      } catch (e) {
        return refusal(e);
      }
    },
  );

  server.registerTool(
    "seed_app_ideas",
    {
      title: "Add Mynt's shipped app ideas",
      description:
        "Admin: add the app ideas that ship with Mynt (workspaces/coding-build/templates/ideas.seed.json) that aren't in the database yet. Safe to run again: an idea already there, edited or retired, is never overwritten. Mynt never does this on its own.",
      inputSchema: {},
    },
    async () => {
      const result = await seedAppIdeas(store.db, user.id);
      await store.audit(user.id, "seed_app_ideas", "app_ideas", { inserted: result.inserted, kept: result.kept.length });
      return json(result);
    },
  );
}
