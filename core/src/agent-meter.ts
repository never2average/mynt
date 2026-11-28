// What every agent run spends on the model, counted where all of it passes: Mynt's agent proxy. An agent can
// start nested Claude runs of its own (a security workflow launching sub-agents, say); its own reported cost misses
// those, the proxy doesn't. Each response's usage is priced and added to its run's ledger, and a run whose ledger
// reaches its cap gets no more calls.
import type { Db } from "./db.js";

// US$ per million tokens, first-party rates. Vertex AI is priced by Google; these are the estimate the caps use.
// Cache writes cost 1.25x input (5-minute) or 2x (1-hour); reads as listed.
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}
const PRICES: [RegExp, Price][] = [
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/haiku-5/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  [/haiku/, { input: 1, output: 5, cacheRead: 0.1 }],
];
// A model we don't know is priced as the dearest we do, so the meter errs high, never low.
const UNKNOWN: Price = PRICES[0][1];

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

export function priceUsage(model: string, u: Usage): number {
  const p = PRICES.find(([re]) => re.test(model))?.[1] ?? UNKNOWN;
  const writes1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const writes5m = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - writes1h);
  const perToken =
    (u.input_tokens ?? 0) * p.input +
    (u.output_tokens ?? 0) * p.output +
    (u.cache_read_input_tokens ?? 0) * p.cacheRead +
    writes5m * p.input * 1.25 +
    writes1h * p.input * 2;
  return perToken / 1_000_000;
}

// Reads usage out of a response as it streams past: a JSON body, or server-sent events (message_start carries the
// input side, message_delta the running output count).
export class UsageReader {
  private buffer = "";
  private usage: Usage = {};
  constructor(private readonly streamed: boolean) {}

  push(chunk: Buffer) {
    this.buffer += chunk.toString("utf8");
    if (!this.streamed) return;
    let i: number;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (line.startsWith("data:")) this.event(line.slice(5).trim());
    }
  }

  private event(data: string) {
    try {
      const e = JSON.parse(data) as { type?: string; message?: { usage?: Usage }; usage?: Usage };
      if (e.type === "message_start" && e.message?.usage) this.usage = { ...this.usage, ...e.message.usage };
      if (e.type === "message_delta" && e.usage) this.usage = { ...this.usage, ...Object.fromEntries(Object.entries(e.usage).filter(([, v]) => v != null)) };
    } catch {
      // not JSON: ignore
    }
  }

  result(): Usage {
    if (this.streamed) return this.usage;
    try {
      return (JSON.parse(this.buffer) as { usage?: Usage }).usage ?? {};
    } catch {
      return {};
    }
  }
}

const TABLE = `
  CREATE TABLE IF NOT EXISTS financial_products.agent_spend (
    run_key text PRIMARY KEY,
    usd numeric NOT NULL DEFAULT 0,
    calls integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  -- Calls whose spend couldn't be measured (the backend had no price set when the answer arrived, or the answer
  -- carried no usage), and the tokens of the ones that said. Never turned into dollars: a run with any such call
  -- has a cost that is "not measured", and whoever budgets it counts its whole cap instead.
  ALTER TABLE financial_products.agent_spend ADD COLUMN IF NOT EXISTS unmeasured_calls integer NOT NULL DEFAULT 0;
  ALTER TABLE financial_products.agent_spend ADD COLUMN IF NOT EXISTS unmeasured_input_tokens bigint NOT NULL DEFAULT 0;
  ALTER TABLE financial_products.agent_spend ADD COLUMN IF NOT EXISTS unmeasured_output_tokens bigint NOT NULL DEFAULT 0;
  -- A model provider's refusals of a run's requests (its safeguards declined them), with the provider's request id.
  CREATE TABLE IF NOT EXISTS financial_products.agent_refusals (
    id bigserial PRIMARY KEY,
    run_key text NOT NULL,
    category text,
    request_id text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS agent_refusals_run_idx ON financial_products.agent_refusals (run_key, id);
`;

export class AgentMeter {
  private constructor(private readonly db: Db) {}

  static async open(db: Db) {
    await db.exec(TABLE);
    return new AgentMeter(db);
  }

  async spent(runKey: string): Promise<number> {
    const r = (await this.db.query("SELECT usd FROM financial_products.agent_spend WHERE run_key = $1", [runKey])).rows[0] as { usd?: unknown } | undefined;
    return Number(r?.usd ?? 0);
  }

  async add(runKey: string, usd: number) {
    if (!(usd > 0)) return;
    await this.db.query(
      `INSERT INTO financial_products.agent_spend (run_key, usd, calls) VALUES ($1, $2, 1)
       ON CONFLICT (run_key) DO UPDATE SET usd = agent_spend.usd + EXCLUDED.usd, calls = agent_spend.calls + 1, updated_at = now()`,
      [runKey, usd],
    );
  }

  /** A call that was answered and whose spend couldn't be priced: counted, with its tokens where it gave them. */
  async addUnmeasured(runKey: string, tokens: { input: number; output: number } | null) {
    await this.db.query(
      `INSERT INTO financial_products.agent_spend (run_key, unmeasured_calls, unmeasured_input_tokens, unmeasured_output_tokens) VALUES ($1, 1, $2, $3)
       ON CONFLICT (run_key) DO UPDATE SET unmeasured_calls = agent_spend.unmeasured_calls + 1, unmeasured_input_tokens = agent_spend.unmeasured_input_tokens + EXCLUDED.unmeasured_input_tokens,
         unmeasured_output_tokens = agent_spend.unmeasured_output_tokens + EXCLUDED.unmeasured_output_tokens, updated_at = now()`,
      [runKey, Math.max(0, Math.round(tokens?.input ?? 0)), Math.max(0, Math.round(tokens?.output ?? 0))],
    );
  }

  /** The run's calls whose spend wasn't measured; null when every call was (or it made none). */
  async unmeasured(runKey: string): Promise<{ calls: number; input_tokens: number; output_tokens: number } | null> {
    const r = (await this.db.query("SELECT unmeasured_calls, unmeasured_input_tokens, unmeasured_output_tokens FROM financial_products.agent_spend WHERE run_key = $1", [runKey])).rows[0] as Record<string, unknown> | undefined;
    const calls = Number(r?.unmeasured_calls ?? 0);
    return calls > 0 ? { calls, input_tokens: Number(r!.unmeasured_input_tokens ?? 0), output_tokens: Number(r!.unmeasured_output_tokens ?? 0) } : null;
  }

  async addRefusal(runKey: string, refusal: { category: string | null; request_id: string | null }) {
    await this.db.query(`INSERT INTO financial_products.agent_refusals (run_key, category, request_id) VALUES ($1, $2, $3)`, [runKey, refusal.category?.slice(0, 80) ?? null, refusal.request_id?.slice(0, 200) ?? null]);
  }

  /** The provider's refusals of this run's requests, oldest first. */
  async refusals(runKey: string): Promise<{ category: string | null; request_id: string | null; at: string }[]> {
    const { rows } = await this.db.query("SELECT category, request_id, created_at FROM financial_products.agent_refusals WHERE run_key = $1 ORDER BY id", [runKey]);
    return (rows as Record<string, unknown>[]).map((r) => ({ category: (r.category as string | null) ?? null, request_id: (r.request_id as string | null) ?? null, at: new Date(r.created_at as string).toISOString() }));
  }
}
