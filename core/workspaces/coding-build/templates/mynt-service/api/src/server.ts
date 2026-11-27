// A service on Mynt: one endpoint, POST /mynt/services/<service type key>, authenticated by Mynt-Signature alone.
// It holds no Mynt app key and forwards nothing to Mynt.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleService } from "./handle-service.js";
import { createVendorService, loadContract } from "./vendor-service.js";

const contract = loadContract();
// Set by Mynt's hosting on every deploy (never in the repository, the browser or a log).
const secret = () => process.env.MYNT_VENDOR_SIGNING_SECRET || undefined;
const answer = createVendorService({ contract, secret, handle: handleService });

const MAX_BODY = 256 * 1024;
const body = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req
      .on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) return reject(new Error("too_large"));
        chunks.push(c);
      })
      .on("end", () => resolve(Buffer.concat(chunks)))
      .on("error", reject);
  });
const send = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(data));
};

createServer(async (req, res) => {
  try {
    const path = (req.url ?? "/").split("?")[0];
    const service = /^\/mynt\/services\/([a-z][a-z0-9_]{0,59})$/.exec(path);
    if (service) {
      if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
      const raw = await body(req); // the raw bytes: the signature is over them
      const a = await answer(service[1], req.headers["mynt-signature"] as string | undefined, raw);
      return send(res, a.status, a.body);
    }
    const api = path.replace(/^\/api/, "");
    if (req.method === "GET" && api === "/healthz") return send(res, 200, { ok: true });
    // For the status page: nothing secret, only whether the signing secret is set.
    if (req.method === "GET" && api === "/status")
      return send(res, 200, { name: contract.service_type.name, service_type: contract.service_type.key, region: contract.service_type.region, endpoint_path: contract.endpoint.app_path, signing_secret_set: Boolean(secret()) });
    send(res, 404, { error: "not_found" });
  } catch (e) {
    console.error("request failed", (e as Error).name); // names only, never a customer's data
    send(res, 400, { error: "bad_request" });
  }
}).listen(Number(process.env.PORT ?? 3000));
