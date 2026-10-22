// UK-63: every console/portal UX-bar rule (B6, B7, B17) fails on a seeded violation, and a clean
// chrome fragment passes them all (the negative control the rendered-DOM lint is trusted on).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  UX_BAR_RULES,
  reduceTransparency,
  uxBarFindings,
  withoutUxDebt,
} from "../src/ux-bar.ts";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

const BASE = `<style>
  :root { --pk-focus: rgb(120 80 230); --pk-state-ring: rgb(120 80 230); }
  body { margin: 0; font: 400 15px/22px sans-serif; color: rgb(230 232 238); background: rgb(16 18 24); }
  .card { border: 1px solid rgb(80 84 96); border-radius: 12px; padding: 20px; inline-size: 300px; }
  button { font: 500 15px sans-serif; }
  button:focus-visible { outline: 2px solid var(--pk-focus); outline-offset: 2px; }
  h1 { font: 600 28px/34px sans-serif; margin: 0 }
</style>`;

async function findings(
  body: string,
  focus = false,
  reduced = false,
): Promise<string[]> {
  const p = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await p.setContent(
    `<!doctype html><html lang="en"><head>${BASE}</head><body>${body}</body></html>`,
  );
  if (reduced) await reduceTransparency(p);
  const r = await uxBarFindings(p, { focus, maxTabs: 6 });
  await p.close();
  return r;
}

const CLEAN = `<nav aria-label="Breadcrumb"><ol><li>Licenses</li><li>Record</li></ol></nav>
<h1>Record</h1><div class="card"><p>Body</p><button>Save</button></div>
<div class="card" style="box-shadow: 0 1px 2px rgb(0 0 0 / .4)">Neutral shadow</div>
<div class="card" style="box-shadow: rgb(120 80 230) 3px 0 0 0 inset">Selected marker</div>
<style>:root { --pk-service-license: rgb(198 233 64); --pk-danger: rgb(219 66 60); }</style>
<div class="card" style="border-color: rgb(219 66 60)">A danger rim is a status colour</div>`;

const ART = `<img alt="" width="200" height="120" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" style="display:block;inline-size:200px;block-size:120px">`;

const SEEDED: Record<string, string> = {
  "ux-glow": `<div class="card" style="box-shadow: 0 0 24px rgb(198 233 64 / .6)">Glow</div>`,
  "ux-gradient": `<div class="card" style="background-image: linear-gradient(rgb(0 0 0), rgb(40 40 90))">Wash</div>`,
  "ux-rim-neutral": `<style>:root { --pk-service-license: rgb(198 233 64); }</style><div class="card" style="border-color: rgb(198 233 64)">Tinted rim</div>`,
  "ux-eyebrow-breadcrumb": `<nav aria-label="Breadcrumb"><ol><li>Licenses</li></ol></nav><p data-eyebrow>Licenses</p><h1>Record</h1>`,
  "ux-tagline": `<p class="tagline">Keys for everything you build</p>`,
  "ux-name-over-art": `<div style="position:relative;inline-size:200px">${ART}<span style="position:absolute;inset-block-end:8px;inset-inline-start:8px">Tidewater</span></div>`,
  "ux-weight": `<p style="font-weight: 700">Heavy</p>`,
  "ux-transparency": `<div style="backdrop-filter: blur(6px)">Frosted</div>`,
  "ux-focus-colour": `<style>.b:focus-visible { outline: 2px solid rgb(250 199 0) }</style><button class="b">Go</button>`,
};

describe("the console and portal UX bar (UK-63)", () => {
  it("passes a clean chrome fragment, focus ring included", async () => {
    expect(await findings(CLEAN, true)).toEqual([]);
  });

  it("covers every rule with a seeded violation", () => {
    expect(Object.keys(SEEDED).sort()).toEqual([...UX_BAR_RULES].sort());
  });

  for (const [rule, body] of Object.entries(SEEDED)) {
    it(`flags ${rule}`, async () => {
      const found = await findings(
        body,
        rule === "ux-focus-colour",
        rule === "ux-transparency",
      );
      expect(
        found.filter((f) => f.startsWith(`${rule}:`)).length,
      ).toBeGreaterThan(0);
    });
  }

  it("does not flag text a solid bar covers", async () => {
    const found = await findings(
      `<div style="position:relative;inline-size:200px">${ART}<div style="position:absolute;inset:0;background:rgb(16 18 24)"></div><span style="position:absolute;inset-block-end:8px;inset-inline-start:8px;z-index:1;background:rgb(16 18 24)">Library</span></div>`,
    );
    expect(found.filter((f) => f.startsWith("ux-name-over-art"))).toEqual([]);
  });

  it("flags a neutral two-stop wash and allows a fade to transparent", async () => {
    const wash = await findings(
      `<div class="card" style="background-image: linear-gradient(rgb(20 20 20), rgb(90 90 90))">Wash</div>`,
    );
    expect(wash.some((f) => f.startsWith("ux-gradient:"))).toBe(true);
    const fade = await findings(
      `<div class="card" style="background-image: linear-gradient(rgb(16 18 24), transparent)">Fade</div>`,
    );
    expect(fade).toEqual([]);
  });

  it("allows a blur when transparency is not reduced", async () => {
    expect(
      await findings(`<div style="backdrop-filter: blur(6px)">Frosted</div>`),
    ).toEqual([]);
  });

  it("lets a debt entry own a finding and leaves the rest", () => {
    const f = [
      "ux-glow: a.x has a coloured shadow",
      "ux-weight: p is weight 700",
    ];
    const debt = [
      { rule: "ux-glow" as const, match: /\.x/, owner: "T", why: "t" },
    ];
    const used = new Set<number>();
    expect(withoutUxDebt("home", f, debt, used)).toEqual([f[1]]);
    expect([...used]).toEqual([0]);
  });
});
