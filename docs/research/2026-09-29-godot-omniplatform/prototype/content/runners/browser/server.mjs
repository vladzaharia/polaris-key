// Static server with single-range Range support + Compression Dictionary Transport (dcz) endpoints.
// usage: node server.mjs <root> <port>
import http from "node:http";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import zlib from "node:zlib";
import { join, extname, normalize } from "node:path";

const [root, port = "8123"] = process.argv.slice(2);
const TYPES = {
  ".html": "text/html",
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".json": "application/json",
  ".wasm": "application/wasm",
};
const log = [];

// CDT fixtures: v1 payload as the dictionary, v2 as the target, the vector's --patch-from frame as the dcz body.
const V = join(root, process.env.CDT_SET || "vectors/small");
const BIG = process.env.CDT_BIG;
const v1 = BIG
  ? readFileSync(join(BIG, "big_old.bin"))
  : zlib.zstdDecompressSync(readFileSync(join(V, "blobs/payload/v1.full.zst")));
const delta = readFileSync(
  BIG ? join(BIG, "big.pf.zst") : join(V, "blobs/deltas/v1-v2.pf.zst"),
);
const v2 = zlib.zstdDecompressSync(delta, {
  dictionary: v1,
  params: { [zlib.constants.ZSTD_d_windowLogMax]: 31 },
});
const v1sha = createHash("sha256").update(v1).digest();
const dczHeader = Buffer.concat([
  Buffer.from([0x5e, 0x2a, 0x4d, 0x18, 0x20, 0x00, 0x00, 0x00]),
  v1sha,
]);
const dcz = Buffer.concat([dczHeader, delta]);

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const entry = {
      path: url.pathname,
      range: req.headers.range,
      ae: req.headers["accept-encoding"],
      ad: req.headers["available-dictionary"],
    };
    log.push(entry);
    if (url.pathname === "/log") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(log));
    }
    if (url.pathname === "/cdt/v1.pck") {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "cache-control": "max-age=3600",
        "use-as-dictionary": 'match="/cdt/*", match-dest=("")',
      });
      return res.end(v1);
    }
    if (url.pathname === "/cdt/v2.pck") {
      const ad = req.headers["available-dictionary"] || "";
      const want = ":" + v1sha.toString("base64") + ":";
      const acceptsDcz = (req.headers["accept-encoding"] || "").includes("dcz");
      if (ad === want && acceptsDcz) {
        entry.sent = "dcz";
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-encoding": "dcz",
          vary: "accept-encoding, available-dictionary",
          "cache-control": "no-store",
        });
        return res.end(dcz);
      }
      entry.sent = "identity";
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        vary: "accept-encoding, available-dictionary",
        "cache-control": "no-store",
      });
      return res.end(v2);
    }
    const p = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!p.startsWith(normalize(root))) {
      res.writeHead(403);
      return res.end();
    }
    let st;
    let pp = p;
    try {
      st = statSync(pp);
    } catch {
      try {
        pp = p + ".js";
        st = statSync(pp);
      } catch {
        res.writeHead(404);
        return res.end();
      }
    }
    if (st.isDirectory()) {
      if (!url.pathname.endsWith("/")) {
        res.writeHead(301, { location: url.pathname + "/" });
        return res.end();
      }
      try {
        pp = join(pp, "index.js");
        st = statSync(pp);
      } catch {
        res.writeHead(404);
        return res.end();
      }
    }
    const h = {
      "content-type": TYPES[extname(pp)] || "application/octet-stream",
      "accept-ranges": "bytes",
      "cache-control": "no-cache",
    };
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
    if (m) {
      const start = +m[1],
        end = m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
      if (start >= st.size) {
        res.writeHead(416, { "content-range": `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, {
        ...h,
        "content-range": `bytes ${start}-${end}/${st.size}`,
        "content-length": end - start + 1,
      });
      return createReadStream(pp, { start, end }).pipe(res);
    }
    if (req.headers.range) {
      entry.note = "multi/unsupported range -> 200";
    }
    res.writeHead(200, { ...h, "content-length": st.size });
    createReadStream(pp).pipe(res);
  })
  .listen(+port, "127.0.0.1", () =>
    console.log(
      `serving ${root} on http://127.0.0.1:${port} (v2 ${v2.length} B, dcz ${dcz.length} B)`,
    ),
  );
