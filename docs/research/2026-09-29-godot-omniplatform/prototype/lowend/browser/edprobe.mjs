// Isolates WebCrypto Ed25519 failures step by step (import, then verify at each size), on the page and
// in a dedicated worker, one fresh page per step so a crash names the step that caused it.
// usage: node edprobe.mjs <engine> <base-url>
import { writeFileSync, mkdirSync } from "node:fs";
const pw = await import(
  new URL(
    "../../content/npm/node_modules/playwright-core/index.mjs",
    import.meta.url,
  ).href
);
const [engine = "webkit", base = "http://127.0.0.1:8431"] =
  process.argv.slice(2);
const browser = await pw[engine].launch({ headless: true });
const body = async ({ url, size, where, batch }) => {
  const run = async (url, size, batch) => {
    const unhex = (h) =>
      new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
    const vs = await (await fetch(new URL(url, self.location.origin))).json();
    const v = vs.find((x) => x.name === size);
    const key = await crypto.subtle.importKey(
      "raw",
      unhex(v.pk),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    if (batch === 0) return { imported: true };
    const sig = unhex(v.sig),
      msg = new TextEncoder().encode(v.signingInput);
    let ok = true;
    const t = performance.now();
    for (let i = 0; i < batch; i++)
      ok &&= await crypto.subtle.verify({ name: "Ed25519" }, key, sig, msg);
    return { ok, msPer: (performance.now() - t) / batch };
  };
  if (where === "page") return run(url, size, batch);
  const src = `self.onmessage = async (e) => { try { postMessage(await (${run.toString()})(...e.data)); } catch (err) { postMessage({ error: String(err) }); } };`;
  const w = new Worker(
    URL.createObjectURL(new Blob([src], { type: "text/javascript" })),
  );
  return new Promise((res) => {
    w.onmessage = (e) => res(e.data);
    w.onerror = (e) => res({ error: "worker error " + e.message });
    w.postMessage([url, size, batch]);
  });
};
const out = { engine, version: browser.version(), steps: [] };
for (const where of ["page", "worker"])
  for (const [size, batch] of [
    ["small", 0],
    ["small", 1],
    ["small", 20],
    ["payload87k", 1],
    ["payload87k", 20],
    ["bundle350k", 1],
    ["bundle350k", 10],
  ]) {
    const page = await (await browser.newContext()).newPage();
    let r;
    try {
      await page.goto(`${base}/lowend/browser/blank.html`);
      r = await Promise.race([
        page.evaluate(body, {
          url: `${base}/lowend/project/vectors/ed25519_bench.json`,
          size,
          where,
          batch,
        }),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timeout 60 s")), 60000),
        ),
      ]);
    } catch (e) {
      r = { crashed: String(e.message).split("\n")[0] };
    }
    out.steps.push({ where, size, batch, ...r });
    console.log(where, size, batch, JSON.stringify(r));
    await page
      .context()
      .close()
      .catch(() => {});
  }
// Message-size bisection with a generated key: sign, then verify, one fresh page per size and operation.
const sizes = (
  process.env.SIZES ||
  "1024,4096,16384,32768,49152,57344,61440,65536,65537,81920,98304,131072"
)
  .split(",")
  .map(Number);
out.sizes = [];
for (const n of sizes)
  for (const op of ["sign", "verify"]) {
    const page = await (await browser.newContext()).newPage();
    let r;
    try {
      await page.goto(`${base}/lowend/browser/blank.html`);
      r = await page.evaluate(
        async ({ n, op }) => {
          const k = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
            "sign",
            "verify",
          ]);
          const m = new Uint8Array(n).fill(0x61);
          if (op === "sign") {
            const s = await crypto.subtle.sign(
              { name: "Ed25519" },
              k.privateKey,
              m,
            );
            return { sigBytes: s.byteLength };
          }
          // verify a signature made over the same message on a 32-byte message key? No: sign n first is the
          // step under test above, so verify uses a signature over n bytes made by sign in this page.
          const s = await crypto.subtle.sign(
            { name: "Ed25519" },
            k.privateKey,
            m,
          );
          return {
            ok: await crypto.subtle.verify(
              { name: "Ed25519" },
              k.publicKey,
              s,
              m,
            ),
          };
        },
        { n, op },
      );
    } catch (e) {
      r = { crashed: String(e.message).split("\n")[0] };
    }
    out.sizes.push({ n, op, ...r });
    console.log("size", n, op, JSON.stringify(r));
    await page
      .context()
      .close()
      .catch(() => {});
  }
mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
writeFileSync(
  new URL(
    `../results/edprobe-${process.env.TAG || engine}.json`,
    import.meta.url,
  ),
  JSON.stringify(out),
);
await browser.close();
