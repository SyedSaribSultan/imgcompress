/* Static server for web/ that mirrors production's headers - above all the
 * strict CSP. Python's http.server sends none, which let two CSP violations
 * (inline style attributes) reach production invisibly. Local must equal prod. */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..", "web");
const PORT = Number(process.argv[2] || 8151);

const VERCEL = JSON.parse(
  await readFile(path.join(ROOT, "vercel.json"), "utf8"));
const GLOBAL = VERCEL.headers.find((h) => h.source === "/(.*)").headers;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/vnd.microsoft.icon",
  ".wasm": "application/wasm", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

createServer(async (req, res) => {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(ROOT, rel);
  if (!file.startsWith(path.resolve(ROOT))) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    const headers = { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" };
    for (const h of GLOBAL) headers[h.key] = h.value;
    res.writeHead(200, headers).end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`serving ${ROOT} on ${PORT} with prod headers`));
