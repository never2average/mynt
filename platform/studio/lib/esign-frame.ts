// The origins the studio may frame e-signature signing pages from, learnt at run time: Mynt publishes its e-signature
// adapter's own list (GET <Mynt>/esign/frame-origins, empty while e-signature is off), and ESIGN_FRAME_SRC may add
// to it. The Content-Security-Policy (proxy.ts) and the Sign sheet (its route) use the same list, so a signing page
// is framed exactly when the policy allows it. Read at most every few minutes; Mynt unreachable means none.
import { esignFrameSources } from "./agreement-esign";

const TTL_MS = 5 * 60 * 1000;
const FIRST_WAIT_MS = 1500;
let cache: { at: number; origins: string[] } | null = null;
let inflight: Promise<void> | null = null;

function myntOrigin(): string | null {
  const raw = process.env.MYNT_MCP_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

async function refresh(fetcher: typeof fetch): Promise<void> {
  const origin = myntOrigin();
  if (!origin) {
    cache = { at: Date.now(), origins: [] };
    return;
  }
  try {
    const res = await fetcher(`${origin}/esign/frame-origins`, { cache: "no-store", signal: AbortSignal.timeout(FIRST_WAIT_MS) });
    const body = (await res.json().catch(() => null)) as { origins?: unknown } | null;
    const listed = Array.isArray(body?.origins) ? body.origins.filter((o): o is string => typeof o === "string") : [];
    cache = { at: Date.now(), origins: res.ok ? esignFrameSources(listed.join(" ")) : (cache?.origins ?? []) };
  } catch {
    cache = { at: Date.now(), origins: cache?.origins ?? [] };
  }
}

export async function esignFrameOrigins(fetcher: typeof fetch = fetch): Promise<string[]> {
  const stale = !cache || Date.now() - cache.at > TTL_MS;
  if (stale) {
    inflight ??= refresh(fetcher).finally(() => {
      inflight = null;
    });
    // The first time, wait (briefly) for the list; after that, use what's known while it's read again.
    if (!cache) await inflight;
  }
  return [...new Set([...esignFrameSources(process.env.ESIGN_FRAME_SRC), ...(cache?.origins ?? [])])];
}

/** For the tests: forget what was read. */
export const resetEsignFrameOrigins = () => {
  cache = null;
  inflight = null;
};
