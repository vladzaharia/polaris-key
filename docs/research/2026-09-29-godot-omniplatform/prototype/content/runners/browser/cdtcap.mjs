import http from "node:http";
// playwright-core 1.63.0 from content/npm (see README) unless PLAYWRIGHT_CORE names another entry point;
// Chromium from CHROMIUM, else the browser Playwright itself installed.
const { chromium } = await import(
  process.env.PLAYWRIGHT_CORE ||
    new URL("../../npm/node_modules/playwright-core/index.mjs", import.meta.url)
      .href
);
const log = [];
const srv = http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    log.push({
      p: u.pathname + u.search,
      ad: req.headers["available-dictionary"],
      ae: req.headers["accept-encoding"],
    });
    if (u.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<!doctype html><title>x</title>");
    }
    const n = +u.searchParams.get("n");
    if (u.pathname.startsWith("/d/dict")) {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "cache-control": "max-age=3600",
        "use-as-dictionary": `match="/d/t${n}*"`,
      });
      const b = Buffer.alloc(1 << 20, 1);
      let left = n;
      const w = () => {
        while (left > 0) {
          const k = Math.min(left, b.length);
          left -= k;
          if (!res.write(b.subarray(0, k))) return res.once("drain", w);
        }
        res.end();
      };
      return w();
    }
    res.writeHead(200, {
      "content-type": "text/plain",
      "cache-control": "no-store",
    });
    res.end("x");
  })
  .listen(8130, "127.0.0.1");
const b = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
});
const MiB = 1 << 20;
for (const n of (process.env.SIZES || "").split(",").map(Number)) {
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  await p.goto("http://127.0.0.1:8130/");
  await p.evaluate(async (n) => {
    await (await fetch(`/d/dict?n=${n}`)).arrayBuffer();
    await new Promise((r) => setTimeout(r, 1200));
    await (await fetch(`/d/t${n}?n=${n}`)).text();
  }, n);
  const e = log.filter((x) => x.p === `/d/t${n}?n=${n}`).pop();
  console.log(
    `dictionary ${n} B (${(n / MiB).toFixed(2)} MiB): offered=${!!e.ad}`,
  );
  await ctx.close();
}
await b.close();
srv.close();
