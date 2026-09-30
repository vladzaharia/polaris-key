// S-05 (c) harness server: serves the web export and the packs, counts pack GETs (to tell network
// from HTTP-cache hits), and collects the probe's POST /report bodies.
// usage: node server.mjs [port]   (serves ./export and ../out/c/packs; writes ../out/c/reports.jsonl)
import { createServer } from 'node:http';
import { createReadStream, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8765);
const exportDir = join(here, 'export');
const packDir = join(here, '..', 'out', 'c', 'packs');
const outDir = join(here, '..', 'out', 'c');
mkdirSync(outDir, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.pck': 'application/octet-stream', '.png': 'image/png' };
const counts = {};
const reports = [];

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/report') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      // Annotate with the pack GETs served so far, so consecutive reports give network vs cache.
      let rec = body;
      try { const o = JSON.parse(body); o._server_pack_gets_total = Object.values(counts).reduce((a, b) => a + b, 0); rec = JSON.stringify(o); } catch {}
      reports.push(rec);
      appendFileSync(join(outDir, 'reports.jsonl'), rec.replace(/\n/g, ' ') + '\n');
      res.writeHead(204).end();
    });
    return;
  }
  if (url.pathname === '/_reports') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reports));
  if (url.pathname === '/_counts') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(counts));
  if (url.pathname === '/_reset') { reports.length = 0; for (const k in counts) delete counts[k]; return res.writeHead(204).end(); }
  const isPack = url.pathname.startsWith('/packs/');
  const file = isPack ? join(packDir, url.pathname.slice(7)) : join(exportDir, url.pathname === '/' ? 'index.html' : url.pathname);
  let st;
  try { st = statSync(file); } catch { return res.writeHead(404).end(); }
  if (isPack) counts[url.pathname] = (counts[url.pathname] || 0) + 1;
  res.writeHead(200, {
    'content-type': types[extname(file)] || 'application/octet-stream',
    'content-length': st.size,
    'cache-control': isPack ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`s05 web server on http://localhost:${port}`));
