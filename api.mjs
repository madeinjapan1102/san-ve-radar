import http from "node:http";
import crypto from "node:crypto";
import { readStore, writeStore } from "./store-file.mjs";
import { listProviders } from "./scrapers.mjs";

const port = Number(process.env.PORT || 10000);
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" }); res.end(JSON.stringify(body)); };
const body = async (req) => { let raw = ""; for await (const chunk of req) raw += chunk; return raw ? JSON.parse(raw) : {}; };

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, service: "san-ve-radar-api", time: new Date().toISOString() });
    if (req.method === "GET" && url.pathname === "/providers") return json(res, 200, { providers: listProviders() });
    if (req.method === "GET" && url.pathname === "/itineraries") return json(res, 200, { itineraries: (await readStore()).itineraries });
    if (req.method === "POST" && url.pathname === "/itineraries") {
      const input = await body(req);
      if (!input.origin || !input.destination || !input.departureDate) return json(res, 400, { error: "origin, destination and departureDate are required" });
      const store = await readStore();
      const item = { id: crypto.randomUUID(), ...input, enabled: true, createdAt: new Date().toISOString() };
      store.itineraries.push(item); await writeStore(store); return json(res, 201, item);
    }
    if (req.method === "GET" && url.pathname === "/quotes") return json(res, 200, { quotes: (await readStore()).quotes });
    if (req.method === "GET" && url.pathname === "/notifications") return json(res, 200, { notifications: (await readStore()).notifications });
    return json(res, 404, { error: "not_found" });
  } catch (error) { return json(res, 500, { error: "server_error", message: error.message }); }
});

server.listen(port, () => console.log(`San Ve Radar API listening on ${port}`));
