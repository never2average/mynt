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
}
