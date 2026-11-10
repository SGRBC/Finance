// Minimal static file server for local testing of the app.
// Usage: node tools/serve.mjs [host] [port]
//   Default host is 127.0.0.1 (this computer only).
//   To test from your phone on the same Wi-Fi, pass your computer's specific LAN IP, e.g.
//   node tools/serve.mjs 192.168.1.20 8080
// NOTE: phones only allow "Install app"/offline mode over HTTPS, so for real phone use,
// host the /app folder on any HTTPS static host (see README.md).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const host = process.argv[2] || "127.0.0.1";
const port = Number(process.argv[3] || 8080);
if (host === "0.0.0.0" || host === "::") {
  console.error("Refusing to bind to all interfaces. Use 127.0.0.1 or a specific LAN IP.");
  process.exit(1);
}
const root = resolve(fileURLToPath(new URL("../app", import.meta.url)));
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png",
};

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = resolve(root, "." + (path.endsWith("/") ? path + "index.html" : path));
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end("Forbidden"); return; }
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": types[extname(file)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, host, () => console.log(`Serving app at http://${host}:${port}/`));
