// S-05 (c) driver: runs the web probe in Playwright Chromium, Firefox and WebKit.
// usage: node run_c.mjs [browsers=chromium,firefox,webkit] [ns=1,3,6] [modes=idb,mem] [port=8765]
// Needs `node server.mjs` running. Appends one JSON line per page load to ../out/c/runs.jsonl.
import { chromium, firefox, webkit } from "playwright-core";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) =>
  (process.argv.find((a) => a.startsWith(k + "=")) || `${k}=${d}`).split(
    "=",
  )[1];
const browsers = arg("browsers", "chromium,firefox,webkit").split(",");
const ns = arg("ns", "1,3,6").split(",").map(Number);
const modes = arg("modes", "idb,mem").split(",");
const chunk = arg("chunk", "65536");
const privateNs = arg("private", "3").split(",").map(Number);
const port = Number(arg("port", 8765));
const base = `http://localhost:${port}`;
const out = join(here, "..", "out", "c");
mkdirSync(out, { recursive: true });
const types = { chromium, firefox, webkit };

const get = async (p) => (await fetch(base + p)).json();
const rssMB = (needle) => {
  // RSS (MB) of the browser: every process whose command line contains `needle` (the profile
  // directory for Chromium/Firefox, the Playwright WebKit bundle for WebKit, whose WebContent XPC
  // services are children of launchd) plus all their descendants.
  try {
    const rows = execFileSync(
      "ps",
      ["-axww", "-o", "pid=,ppid=,rss=,command="],
      { maxBuffer: 64 << 20 },
    )
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
        return m && { pid: +m[1], ppid: +m[2], rss: +m[3], cmd: m[4] };
      })
      .filter(Boolean);
    const keep = new Set(
      rows
        .filter((r) => r.cmd.includes(needle) && !r.cmd.includes("run_c.mjs"))
        .map((r) => r.pid),
    );
    let grown = true;
    while (grown) {
      grown = false;
      for (const r of rows)
        if (!keep.has(r.pid) && keep.has(r.ppid)) {
          keep.add(r.pid);
          grown = true;
        }
    }
    return Math.round(
      rows.filter((r) => keep.has(r.pid)).reduce((s, r) => s + r.rss, 0) / 1024,
    );
  } catch {
    return -1;
  }
};

async function load(page, bname, mode, n, run, needle) {
  const before = (await get("/_reports")).length;
  const c0 = await get("/_counts");
  const t0 = Date.now();
  await page.goto(`${base}/?mode=${mode}&n=${n}&run=${run}&chunk=${chunk}`, {
    waitUntil: "load",
  });
  let rep = null;
  for (let i = 0; i < 600 && !rep; i++) {
    const rs = await get("/_reports");
    if (rs.length > before) rep = JSON.parse(rs[rs.length - 1]);
    else await new Promise((r) => setTimeout(r, 250));
  }
  const c1 = await get("/_counts");
  let cdpHeap = null;
  if (bname === "chromium") {
    try {
      const s = await page.context().newCDPSession(page);
      cdpHeap = await s.send("Runtime.getHeapUsage");
      await s.detach();
    } catch (e) {
      cdpHeap = { error: String(e) };
    }
  }
  const packGets = Object.keys(c1).reduce(
    (s, k) => s + (c1[k] - (c0[k] || 0)),
    0,
  );
  const row = {
    browser: bname,
    mode,
    n,
    run,
    wall_ms: Date.now() - t0,
    rss_mb: rssMB(needle),
    cdp_heap: cdpHeap,
    chunk,
    pack_gets_from_server: packGets,
    rep,
  };
  appendFileSync(join(out, "runs.jsonl"), JSON.stringify(row) + "\n");
  const r = rep || {};
  console.log(
    [
      bname,
      mode,
      n,
      run,
      `ready=${Math.round(r.t_ready_js_ms)}ms`,
      `fetch=${Math.round(r.fetch_total_ms)}ms`,
      `mount=${(r.mounts || []).map((m) => m.ms.toFixed(1)).join("/")}`,
      `atBoot=${Object.keys(r.installed_at_boot || {}).length}`,
      `gets=${packGets}`,
      `rss=${row.rss_mb}MB`,
      `cdp=${cdpHeap ? Math.round((cdpHeap.usedSize + (cdpHeap.backingStorageSize || 0)) / 1e6) + "MB" : "-"}`,
      `verify=${(r.verify || []).map((v) => v.sha_ok).join(",")}`,
    ].join(" "),
  );
  return row;
}

for (const bname of browsers) {
  const bt = types[bname];
  for (const mode of modes) {
    for (const n of ns) {
      // Persistent profile: first visit, reload, browser restart.
      const prof = join(here, "profiles", `${bname}-${mode}-${n}`);
      const needle = bname === "webkit" ? "ms-playwright/webkit" : prof;
      rmSync(prof, { recursive: true, force: true });
      mkdirSync(prof, { recursive: true });
      let ctx = await bt.launchPersistentContext(prof, { headless: true });
      let page = ctx.pages()[0] || (await ctx.newPage());
      await load(page, bname, mode, n, "first", needle);
      await load(page, bname, mode, n, "reload", needle);
      await ctx.close();
      ctx = await bt.launchPersistentContext(prof, { headless: true });
      page = ctx.pages()[0] || (await ctx.newPage());
      await load(page, bname, mode, n, "restart", needle);
      await ctx.close();
      // Ephemeral context (the private-window analogue): first, reload, then a fresh context.
      if (privateNs.includes(n)) {
        const needle =
          bname === "webkit" ? "ms-playwright/webkit" : "no-rss-for-ephemeral";
        const b = await bt.launch({ headless: true });
        let c = await b.newContext();
        let p = await c.newPage();
        await load(p, bname, mode, n, "private_first", needle);
        await load(p, bname, mode, n, "private_reload", needle);
        await c.close();
        c = await b.newContext();
        p = await c.newPage();
        await load(p, bname, mode, n, "private_new_context", needle);
        await b.close();
      }
    }
  }
}
console.log("done");
