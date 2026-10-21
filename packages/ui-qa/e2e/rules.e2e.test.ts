// Every §7.3 rule fails on a seeded violation, and a clean kit fragment passes them all.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { lintPage, prepare } from "../src/run.ts";
import { RULES } from "../src/rules.ts";
import type { LintResult } from "../src/types.ts";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

// A kit fragment that keeps every rule: theme font, hairlines, real states, one primary.
const BASE = `
<style>
  :root { --c: rgb(38 132 122); --fg: rgb(230 232 238); --bg: rgb(16 18 24); }
  body { margin: 0; font: 400 15px/22px Rubik; color: var(--fg); background: var(--bg); }
  .card { border-radius: 22px; padding: 28px; overflow: hidden; }
  .k-btn { font: 500 15px/1 Rubik; height: 44px; min-width: 96px; border: 0; border-radius: 12px;
    background: var(--c); color: var(--fg); }
  .k-btn:hover { background: var(--bg); }
  .k-btn:active { transform: scale(0.98); }
  .k-btn:disabled, .k-btn[aria-disabled="true"] { opacity: 0.42; }
  .k-btn:focus-visible { outline: 2px solid var(--c); outline-offset: 2px; }
  h1 { font: 600 28px/34px Rubik; margin: 0; text-wrap: balance; }
</style>`;

const page = (body: string) =>
  "data:text/html;base64," +
  Buffer.from(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">${BASE}</head><body><div data-shot="s">${body}</div></body></html>`,
  ).toString("base64");

async function lint(body: string, width = 1200): Promise<LintResult> {
  const p = await browser.newPage({ viewport: { width, height: 900 } });
  await prepare(p);
  await p.goto(page(body));
  const r = await lintPage(p, { fonts: ["Rubik"] });
  await p.close();
  return r;
}

const SEEDED: Record<string, string> = {
  "border-width": `<div style="border: 2px solid var(--c)">Selected</div>`,
  "focus-visible-only": `<style>.b:focus { outline: 2px solid var(--c) }</style><button class="k-btn b">Go</button>`,
  "focus-ring-spread": `<style>.b:focus-visible { box-shadow: 0 0 0 4px var(--c) }</style><button class="k-btn b">Go</button>`,
  "button-glow": `<button class="k-btn" style="box-shadow: 0 6px 16px rgb(0 128 255 / 0.6)">Go</button>`,
  "font-family": `<p style="font-family: Arial">Hello</p>`,
  "font-weight-700": `<p style="font-weight: 700">Hello</p>`,
  "text-size-floor": `<p style="font-size: 11px">Hello</p>`,
  "fractional-font-size": `<style>.p { font-size: 13.5px }</style><p class="p">Hello</p>`,
  "button-uppercase": `<button class="k-btn" style="text-transform: uppercase">Go</button>`,
  "no-vw": `<style>.p { inline-size: 50vw }</style><p class="p">Hello</p>`,
  orphan: `<h1 style="inline-size: 10ch; font: 20px/1.2 monospace; text-wrap: wrap">aaaa bbbb cccc</h1>`,
  "tier-separator": `<div style="display: flex; gap: 8px"><span>Tidewater Studio</span><span>·</span><span>Pro</span></div>`,
  "key-nowrap": `<div class="k-field" style="inline-size: 120px"><span style="overflow-wrap: anywhere">pkey_tidewater_7Q2MXK9RV4TC8HJN</span></div>`,
  "rtl-physical": `<style>.p { margin-left: 4px }</style><p class="p">Hello</p>`,
  "square-in-rounded": `<div style="border-radius: 16px; inline-size: 200px"><div style="background: var(--c); block-size: 40px">Row</div></div>`,
  "glass-on-glass": `<div style="backdrop-filter: blur(20px); padding: 20px"><button class="k-btn" style="backdrop-filter: blur(10px)">Go</button></div>`,
  "scrim-coverage": `<div style="position: relative; inline-size: 300px; block-size: 200px"><div class="scrim" style="position: absolute; inset-block: 0; inset-inline-start: 0; inline-size: 50%"></div></div>`,
  "empty-placeholder": `<div data-art="logo" style="inline-size: 40px; block-size: 40px"></div>`,
  "touch-target": `<div data-ui-touch><button class="k-btn" style="block-size: 30px">Go</button></div>`,
  "no-alert": `<script>function remove() { if (confirm("Remove?")) {} }</script><p>Hello</p>`,
  "interactive-states": `<button style="font: 500 15px Rubik">Go</button>`,
  "colour-literal": `<p style="color: #ff6a3d">Hello</p>`,
  "one-primary": `<div class="card"><button class="k-btn primary">Activate</button><button class="k-btn primary">Sign in</button></div>`,
  // Console shell v2 (ST-48; B4, B17): the service accents are the page's own tokens.
  "accent-as-status": `<style>:root { --pk-service-license: rgb(198 233 64); }</style><p role="status" style="color: rgb(198 233 64)">Active</p>`,
  "state-accent": `<style>:root { --pk-service-license: rgb(198 233 64); --pk-service-config: rgb(250 199 0); }</style><div data-service="license"><a href="#" aria-current="page" style="color: rgb(250 199 0)">Catalog</a></div>`,
  "section-index": `<h2>01 Limits</h2>`,
  "tier-caption": `<figure><figcaption>ios · gate</figcaption><div data-shot="g">Gate</div></figure>`,
  "masthead-tile": `<span data-masthead-tile style="display: inline-block; inline-size: 48px; block-size: 48px"></span>`,
  "x-beside-cancel": `<div role="dialog"><button class="k-btn" aria-label="Close">×</button><button class="k-btn">Cancel</button></div>`,
};

describe("the modernity lint (UI-KITS §7.3)", () => {
  it("passes a clean kit fragment", async () => {
    const r = await lint(
      `<div class="card"><h1>Add your license</h1><p>Your key is in the purchase email.</p><button class="k-btn primary">Activate</button><button class="k-btn">Cancel</button></div>`,
    );
    expect(r.violations).toEqual([]);
    expect(r.strings.map((s) => s.text)).toEqual([
      "Add your license",
      "Your key is in the purchase email.",
      "Activate",
      "Cancel",
    ]);
  });

  it("has a seeded case for every in-page rule", () => {
    const inPage = RULES.filter(
      (r) => !["catalog-string", "kit-source"].includes(r.id),
    ).map((r) => r.id);
    expect(Object.keys(SEEDED).sort()).toEqual(inPage.sort());
  });

  // A rule that depends on the window: the masthead tile is for 1024 px and wider.
  const WIDTH: Record<string, number> = { "masthead-tile": 800 };
  for (const [rule, body] of Object.entries(SEEDED)) {
    it(`fails on a seeded ${rule}`, async () => {
      const r = await lint(body, WIDTH[rule]);
      expect(r.violations.map((v) => v.rule)).toContain(rule);
    });
  }

  it("spares what the console shell v2 rules allow", async () => {
    const tokens = `<style>:root { --pk-service-license: rgb(198 233 64); --pk-service-config: rgb(250 199 0); }</style>`;
    // A selected row in its own service's accent, an ordered step's numeral, the tile at 1024 px.
    const ok = await lint(
      `${tokens}<div data-service="config"><a href="#" aria-current="page" style="color: rgb(250 199 0)">Catalog</a></div><ol><li><h3>01 Create the product</h3></li></ol><span data-masthead-tile style="display: inline-block; inline-size: 48px; block-size: 48px"></span><p role="status">Active</p>`,
      1100,
    );
    expect(ok.violations.map((v) => v.rule)).not.toContain("state-accent");
    expect(ok.violations.map((v) => v.rule)).not.toContain("section-index");
    expect(ok.violations.map((v) => v.rule)).not.toContain("masthead-tile");
    expect(ok.violations.map((v) => v.rule)).not.toContain("accent-as-status");
  });

  it("records a runtime alert() call", async () => {
    const r = await lint(
      `<button class="k-btn" onclick="alert('x')">Go</button>`,
    );
    expect(r.violations.map((v) => v.rule)).not.toContain("no-alert");
    const p = await browser.newPage();
    await prepare(p);
    await p.goto(page(`<p>Hello</p>`));
    await p.evaluate("window.alert('boom')");
    const after = await lintPage(p, { fonts: ["Rubik"] });
    await p.close();
    expect(after.violations.map((v) => v.rule)).toContain("no-alert");
  });

  it("honours chrome and allowances", async () => {
    const p = await browser.newPage();
    await prepare(p);
    await p.goto(
      page(
        `<div class="status" style="font-family: Arial">9:41</div><p class="host" style="font-weight: 700">Sessions</p>`,
      ),
    );
    const r = await lintPage(p, {
      fonts: ["Rubik"],
      chrome: [".status"],
      allow: { "font-weight-700": [".host"] },
    });
    await p.close();
    expect(r.violations).toEqual([]);
    expect(r.strings.map((s) => s.text)).toEqual(["Sessions"]);
  });
});
