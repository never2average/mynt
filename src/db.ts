import pg from "pg";

// Minimal query interface satisfied by a pg Pool (production, e.g. Supabase Postgres)
// and by PGlite (in-process Postgres used in tests).
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
  // Runs `f` on one connection inside BEGIN … COMMIT (ROLLBACK if it throws). A pool has to hand out one client for
  // this; a single-connection database (PGlite) can do without.
  transaction?<T>(f: (tx: Pick<Db, "query">) => Promise<T>): Promise<T>;
}

export function connectPostgres(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: Number(process.env.PGPOOL_MAX ?? 10) });
  return {
    query: (sql, params) => pool.query(sql, params) as never,
    exec: (sql) => pool.query(sql),
    close: () => pool.end(),
    transaction: async (f) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await f({ query: (sql, params) => client.query(sql, params) as never });
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

// One transaction on `db`: its own when it has one (a pool), else BEGIN … COMMIT on its single connection.
export async function inTransaction<T>(db: Db, f: (tx: Pick<Db, "query">) => Promise<T>): Promise<T> {
  if (db.transaction) return db.transaction(f);
  await db.query("BEGIN");
  try {
    const out = await f({ query: (sql, params) => db.query(sql, params) as never });
    await db.query("COMMIT");
    return out;
  } catch (e) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}
