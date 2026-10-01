#!/usr/bin/env node
// S-02 browser probe: what a web client really sends and gets for Range / If-Range, cross-origin.
//
//   PLAYWRIGHT_DIR=/path/with/node_modules/playwright node browser.mjs [chromium,webkit,firefox]
//
// Serves a blank page from 127.0.0.1:8799 (so the probe Worker on PROBE_LOCAL is cross-origin),
// uploads one 4 MiB object through the Worker, then in each browser runs fetch() cases and reads
// the Worker's /_probe/seen log to learn which requests were preceded by a CORS preflight and what
// Accept-Encoding the browser attached. Also tries Cache.put() of a 206. Prints JSON; writes
// out/browser-<run>.json. Playwright is not a repo dependency: install it anywhere and point
// PLAYWRIGHT_DIR at that directory.

import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(
  join(process.env.PLAYWRIGHT_DIR || HERE, "index.js"),
);
const pw = require("playwright");
const LOCAL = process.env.PROBE_LOCAL || "http://127.0.0.1:8787";
const TOKEN = process.env.PROBE_PUT_TOKEN || "local-only-token";
const browsers = (process.argv[2] || "chromium,webkit,firefox").split(",");

const bytes = randomBytes(4 * 1024 * 1024);
const hex = createHash("sha256").update(bytes).digest("hex");
const key = `s02/blobs/sha256/${hex}`;
const up = await fetch(`${LOCAL}/_probe/put/${key}`, {
  method: "PUT",
  headers: { "X-Probe-Token": TOKEN },
  body: bytes,
});
if (up.status !== 201) throw new Error(`upload ${up.status}`);

const page = http.createServer((_q, s) =>
  s
    .writeHead(200, { "Content-Type": "text/html" })
    .end("<!doctype html><title>s02</title>"),
);
await new Promise((r) => page.listen(8799, "127.0.0.1", r));

const CASES = [
  ["no-range", {}],
  ["single-range", { Range: "bytes=0-99" }],
  [
    "single-range-if-range-match",
    { Range: "bytes=0-99", "If-Range": `"${hex}"` },
  ],
  [
    "single-range-if-range-stale",
    { Range: "bytes=0-99", "If-Range": `"${"0".repeat(64)}"` },
  ],
  ["multi-range", { Range: "bytes=0-9,20-29" }],
];

const results = {};
for (const name of browsers) {
  let browser;
  try {
    browser = await pw[name].launch();
  } catch (e) {
    results[name] = { error: String(e.message).split("\n")[0] };
    continue;
  }
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto("http://127.0.0.1:8799/");
  const out = { version: browser.version(), cases: {} };
  // What the browser itself put on the wire (the Worker's view can be rewritten by a local proxy).
  const wire = new Map();
  p.on("request", async (req) => {
    if (req.url().includes("/s02/"))
      wire.set(req.url() + " " + req.method(), await req.allHeaders());
  });
  for (const mode of ["b", "c"]) {
    for (const [cname, headers] of CASES) {
      await fetch(`${LOCAL}/_probe/seen?reset=1`);
      const url = `${LOCAL}/${mode}/${key}?${name}-${cname}-${Date.now()}`;
      const r = await p.evaluate(
        async ({ url, headers }) => {
          try {
            const res = await fetch(url, { headers, cache: "no-store" });
            const buf = await res.arrayBuffer();
            return {
              status: res.status,
              bytes: buf.byteLength,
              contentRange: res.headers.get("content-range"),
              etag: res.headers.get("etag"),
              reprDigest: res.headers.get("repr-digest"),
              decision: res.headers.get("x-probe-decision"),
            };
          } catch (e) {
            return { error: String(e) };
          }
        },
        { url, headers },
      );
      const seen = await (await fetch(`${LOCAL}/_probe/seen`)).json();
      r.preflight = seen.some((s) => s.method === "OPTIONS");
      r.preflightHeaders =
        seen.find((s) => s.method === "OPTIONS")?.[
          "access-control-request-headers"
        ] || "";
      const get = seen.find((s) => s.method === "GET");
      r.sentAcceptEncoding = get?.["accept-encoding"] ?? null;
      r.sentRange = get?.range ?? null;
      r.sentIfRange = get?.["if-range"] ?? null;
      const w = wire.get(url + " GET") || {};
      r.wireAcceptEncoding = w["accept-encoding"] ?? null;
      r.wireRange = w.range ?? null;
      out.cases[`${mode}:${cname}`] = r;
    }
  }
  console.error(`${name}: fetch cases done`);
  // Cache API: put() of a 206 must reject; a full 200 stores and match() ignores Range.
  out.cachePut = await p.evaluate(async (url) => {
    const t = (pr, ms = 10000) =>
      Promise.race([
        pr,
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error(`timeout ${ms} ms`)), ms),
        ),
      ]);
    const res = {};
    let c;
    try {
      c = await t(caches.open("s02"));
    } catch (e) {
      return { open: String(e).slice(0, 160) };
    }
    try {
      const r206 = await fetch(url, { headers: { Range: "bytes=0-99" } });
      await t(c.put(url + "&206", r206));
      res.put206 = "stored";
    } catch (e) {
      res.put206 = String(e).slice(0, 160);
    }
    try {
      const r200 = await fetch(url);
      await t(c.put(url + "&200", r200));
      const m = await t(
        c.match(
          new Request(url + "&200", { headers: { Range: "bytes=0-99" } }),
        ),
      );
      res.put200 = m
        ? `stored; match with Range -> ${m.status} ${(await m.arrayBuffer()).byteLength} B`
        : "not matched";
    } catch (e) {
      res.put200 = String(e).slice(0, 160);
    }
    return res;
  }, `${LOCAL}/b/${key}?cache-${name}`);
  results[name] = out;
  console.error(`${name}: done, closing`);
  await Promise.race([
    browser.close(),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
}
page.close();

const run = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync(join(HERE, "out"), { recursive: true });
writeFileSync(
  join(HERE, "out", `browser-${run}.json`),
  JSON.stringify(results, null, 2),
);
console.log(JSON.stringify(results, null, 2));
