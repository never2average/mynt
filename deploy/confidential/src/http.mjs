import { createServer } from "node:https";
import { Refused } from "./keyhouse.mjs";

// The service's TLS endpoint: TLS 1.3 only, a client certificate from the configured authority required (the caller's
// identity is its common name, checked against policy.json), JSON in and out, bodies capped at 1 MB. Logs carry the
// route, the caller and the outcome only.

const MAX_BODY = 1024 * 1024;

export function startKeyhouseServer(keyhouse, { cert, key, ca, port = 8443, host, log = console.log }) {
  const server = createServer({ cert, key, ca, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" }, async (req, res) => {
    const url = new URL(req.url ?? "/", "https://keyhouse");
    const caller = req.socket.getPeerCertificate()?.subject?.CN ?? "";
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      let body = null;
      if (req.method === "POST") {
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > MAX_BODY) throw new Refused("too_large", 413);
          chunks.push(c);
        }
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      }
      send(200, await keyhouse.handle(req.method, url.pathname, caller, body, url.searchParams));
      log(`${req.method} ${url.pathname} ${caller} 200`);
    } catch (e) {
      const status = e instanceof Refused ? e.status : e instanceof SyntaxError ? 400 : 500;
      const code = e instanceof Refused ? e.code : status === 400 ? "bad_json" : "internal";
      // Never the body, or the message of a library error, or anything it might quote.
      log(`${req.method} ${url.pathname} ${caller} ${status} ${code}`);
      send(status, { error: code });
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
