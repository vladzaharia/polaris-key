// Tiny server for dl_probe: /len sends Content-Length, /chunked uses chunked transfer encoding.
import { createServer } from 'node:http';
const body = Buffer.alloc(3_000_000, 7);
createServer((req, res) => {
  if (req.url === '/len') { res.writeHead(200, { 'content-length': body.length }); res.end(body); }
  else if (req.url === '/chunked') { res.writeHead(200); res.write(body.subarray(0, 1_000_000)); setTimeout(() => res.end(body.subarray(1_000_000)), 50); }
  else res.writeHead(404).end();
}).listen(Number(process.argv[2] || 8766));
