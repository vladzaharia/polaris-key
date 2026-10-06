// Serve the repository root with the Worker's console/portal CSP on every HTML response, so the
// prototypes run under the same `style-src 'self'` / `script-src 'self'` as the real console.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(
  new URL("../../../../../../", import.meta.url),
);
export const PROTO =
  "/docs/research/2026-09-29-godot-omniplatform/prototype/motion/";

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export async function serve() {
  const server = createServer(async (req, res) => {
    const path = normalize(
      decodeURIComponent(new URL(req.url, "http://x").pathname),
    );
    if (path.includes("..")) return res.writeHead(400).end();
    try {
      const body = await readFile(join(REPO, path));
      const headers = {
        "content-type": TYPES[extname(path)] ?? "application/octet-stream",
      };
      if (extname(path) === ".html") headers["content-security-policy"] = CSP;
      res.writeHead(200, headers).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
