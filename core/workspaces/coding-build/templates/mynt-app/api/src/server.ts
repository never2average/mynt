// The only part of the app that holds the app key. Devices get client sessions, never the key.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMyntClient, verifyWebhook, PRODUCT_IDS, CLIENT_ACTIONS } from "mynt-sdk";

const mynt = createMyntClient({ apiKey: process.env.MYNT_API_KEY ?? "", baseUrl: process.env.MYNT_API_BASE || undefined });
const seen = new Set<string>(); // replace with a durable store keyed by event id

const body = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks))).on("error", reject);
  });
const send = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
};

// Replace with your own sign-in: the customer's opaque id, never their personal data.
const customerOf = (req: IncomingMessage) => (req.headers["x-customer-ref"] as string | undefined) ?? null;

createServer(async (req, res) => {
  try {
    const path = (req.url ?? "/").replace(/^\/api/, "").split("?")[0];
    if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true });

    if (req.method === "POST" && path === "/session") {
      const customerRef = customerOf(req);
      if (!customerRef) return send(res, 401, { error: "sign_in_required" });
      // Only the client actions the app's journeys need (the architect's plan lists them).
      const productIds = [...PRODUCT_IDS];
      const scopes = productIds.flatMap((p) => [...CLIENT_ACTIONS[p]]) as never[];
      const s = await mynt.createClientSession(productIds, scopes, { customerRef });
      return send(res, 201, { client_secret: s.client_secret, expires_at: s.expires_at });
    }

    if (req.method === "POST" && path === "/webhooks/mynt") {
      const raw = await body(req); // verify the raw body before anything else
      const event = verifyWebhook(raw, String(req.headers["mynt-signature"] ?? ""), process.env.MYNT_WEBHOOK_SECRET ?? "");
      const eventId = String(event.id ?? "");
      if (!eventId) return send(res, 400, { error: "no_event_id" });
      if (seen.has(eventId)) return send(res, 200, { duplicate: true });
      seen.add(eventId);
      console.log("mynt event", eventId, event.type); // ids and types only, never customer data
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: "not_found" });
  } catch (e) {
    console.error("request failed", (e as Error).name);
    send(res, 400, { error: "bad_request" });
  }
}).listen(Number(process.env.PORT ?? 3000));
