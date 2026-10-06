// Records the integrated web flow prototype (SIGN-IN.md §4.16, §3.18):
//
//   NODE_PATH=packages/admin/node_modules node docs/design/sign-in/prototype/record.cjs
//
// Writes, next to this file:
//   strip-dark.png, strip-light.png   the seven steps of one continuous card, in order
//   motion-dark.png                   one transition (choose → Replace a device) frozen at six times
//   flow-dark.webm                    a screen recording of the whole flow, dark theme
// Fails on any console error (a CSP violation included) or a font that does not load.
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { chromium } = require("playwright");

const dir = __dirname;
const url = (theme) => `file://${path.join(dir, "index.html")}?theme=${theme}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pk-proto-"));
const settle = (page, ms = 700) => page.waitForTimeout(ms);
let failed = false;

async function open(context, theme) {
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") {
      failed = true;
      console.error(`${theme}: ${m.text()}`);
    }
  });
  page.on("pageerror", (e) => {
    failed = true;
    console.error(`${theme}: ${e.message}`);
  });
  await page.goto(url(theme));
  await page.evaluate(() => document.fonts.ready);
  const bad = await page.evaluate(() =>
    [...document.fonts]
      .filter((f) => f.status === "error")
      .map((f) => f.family),
  );
  if (bad.length) {
    failed = true;
    console.error(`${theme}: fonts failed: ${bad.join(", ")}`);
  }
  await settle(page, 400);
  return page;
}

async function shotCard(page, file) {
  const box = await page.locator("#card").boundingBox();
  const pad = 28;
  await page.screenshot({
    path: file,
    clip: {
      x: box.x - pad,
      y: box.y - pad,
      width: box.width + pad * 2,
      height: box.height + pad * 2,
    },
  });
}

// Walks the flow; calls snap(name) at each step once its motion has settled.
async function walk(page, snap) {
  await snap("1 Sign in");
  await page.click('[data-go="code"]');
  await settle(page, 1300);
  await snap("2 Check your email");
  await page.click('[data-action="demo-code"]');
  await settle(page, 2200);
  await snap("3 Choose a license");
  await page.click('.step [data-go="key"]');
  await settle(page);
  await page.click('[data-action="demo-key"]');
  await settle(page, 1300);
  await snap("4 License key, in place");
  await page.click("[data-back]");
  await settle(page, 1500);
  await page.click('[data-go="replace"]');
  await settle(page, 1000);
  await snap("5 Replace a device");
  await page.click("[data-replace]");
  await settle(page, 1300);
  await snap("6 Consent");
  await page.click('[data-go="done"]');
  await settle(page, 1500);
  await snap("7 Return");
}

async function strip(browser, frames, file, title) {
  const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
  const items = frames
    .map(
      (f) =>
        `<figure><img src="file://${f.file}"><figcaption>${f.name}</figcaption></figure>`,
    )
    .join("");
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:${frames.bg};font:600 15px/1.3 system-ui,sans-serif;color:${frames.fg}}
    h2{margin:24px 28px 0;font-size:17px}
    .row{display:flex;gap:18px;align-items:flex-start;padding:16px 28px 28px}
    figure{margin:0;display:flex;flex-direction:column;gap:8px;align-items:center}
    img{width:300px;border-radius:14px}
    figcaption{font-weight:500;opacity:.8}</style><h2>${title}</h2><div class="row">${items}</div>`;
  const htmlFile = path.join(tmp, `${path.basename(file)}.html`);
  fs.writeFileSync(htmlFile, html);
  await page.goto(`file://${htmlFile}`);
  await page.waitForLoadState("load");
  const size = await page.evaluate(() => ({
    w: document.documentElement.scrollWidth,
    h: document.documentElement.scrollHeight,
  }));
  await page.setViewportSize({ width: size.w, height: size.h });
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
}

(async () => {
  const browser = await chromium.launch();
  for (const theme of ["dark", "light"]) {
    const video = theme === "dark";
    const context = await browser.newContext({
      viewport: { width: 1100, height: 1000 },
      deviceScaleFactor: 2,
      ...(video
        ? { recordVideo: { dir: tmp, size: { width: 1100, height: 1000 } } }
        : {}),
    });
    const page = await open(context, theme);
    const frames = [];
    await walk(page, async (name) => {
      const file = path.join(tmp, `${theme}-${frames.length}.png`);
      await shotCard(page, file);
      frames.push({ name, file });
    });
    frames.bg = theme === "dark" ? "#0b0e14" : "#f4f6fb";
    frames.fg = theme === "dark" ? "#e8ebf2" : "#141824";
    const videoPath = video ? await page.video().path() : null;
    await context.close();
    if (videoPath) fs.copyFileSync(videoPath, path.join(dir, "flow-dark.webm"));
    await strip(
      browser,
      frames,
      path.join(dir, `strip-${theme}.png`),
      `One card, start to finish (${theme})`,
    );
    console.log(`${theme}: ${frames.length} steps`);
  }

  // The motion strip: freeze one View Transition (choose → Replace a device) at six times.
  {
    const context = await browser.newContext({
      viewport: { width: 1100, height: 1000 },
      deviceScaleFactor: 2,
    });
    const page = await open(context, "dark");
    await page.click('[data-go="code"]');
    await settle(page, 1300);
    await page.click('[data-action="demo-code"]');
    await settle(page, 2200);
    await page.evaluate(() => {
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = (cb) => (window.__vt = start(cb));
    });
    const box = await page.locator("#card").boundingBox();
    await page.click('[data-go="replace"]');
    await page.evaluate(async () => {
      await window.__vt.ready;
      document.getAnimations().forEach((a) => a.pause());
    });
    const frames = [];
    for (const t of [0, 60, 120, 180, 240, 400]) {
      await page.evaluate((ms) => {
        document.getAnimations().forEach((a) => {
          a.currentTime = ms;
        });
      }, t);
      const file = path.join(tmp, `motion-${t}.png`);
      await page.screenshot({
        path: file,
        clip: {
          x: box.x - 28,
          y: box.y - 28,
          width: box.width + 56,
          height: 980 - box.y,
        },
      });
      frames.push({ name: `${t} ms`, file });
    }
    frames.bg = "#0b0e14";
    frames.fg = "#e8ebf2";
    await context.close();
    await strip(
      browser,
      frames,
      path.join(dir, "motion-dark.png"),
      "Morph: Choose a license → Replace a device (the header and person row stay; the body exits left, the card resizes, the new body enters from the right)",
    );
    console.log("motion: 6 frames");
  }
  await browser.close();
  if (failed) process.exit(1);
})();
