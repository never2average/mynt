// The one marker that keeps the agent benchmarks' own records out of everything people see.
//
// A benchmark run needs a few rows in the shared records: an account nobody can sign in as, one app per coding task
// in that account's workspace, and a stand-in firm holding one draft product per product-desk task. They are marked
// here, and only here: `users.benchmark` is set on the benchmark's account (Store.markBenchmarkUser, called by
// benchmarks.ts and nothing else), and every workspace, app, firm and product inherits the mark from the account
// that creates it, in the same statement that creates it (`inheritBenchmark`). Nothing matches on a name.
//
// Every list, count, search and directory over those five tables leaves marked rows out with `notBenchmark`: the
// platform admin's lists and their totals, the user and firm lists, the product and app catalogues (and so the
// Marketplace, the global search and Ask AI, which read through them), the identity provider's organization sync
// (so no organization is ever created for a benchmark's workspace) and the operations summary. A row is still
// reachable by its id, which is how the benchmark's own services use it. The Agent benchmarks page is the only place
// that lists them (BenchmarkService.records).

const T = "financial_products";

/** The tables that carry the mark. */
export const BENCHMARK_MARKED = ["users", "workspaces", "apps", "entities", "products"] as const;

export const BENCHMARK_MARKER_TABLES = BENCHMARK_MARKED.map((t) => `ALTER TABLE ${T}.${t} ADD COLUMN IF NOT EXISTS benchmark boolean NOT NULL DEFAULT false;`).join("\n");

/** The condition that leaves the benchmarks' records out of a list or count. `alias`: the table's alias in the query. */
export const notBenchmark = (alias?: string) => `NOT ${alias ? `${alias}.` : ""}benchmark`;

/** The value of a new row's mark: its creating account's. `owner`: the SQL for that account's id (a parameter). */
export const inheritBenchmark = (owner: string) => `COALESCE((SELECT bu.benchmark FROM ${T}.users bu WHERE bu.id = ${owner}), false)`;
