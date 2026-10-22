// Every §7.3 rule fails on a seeded violation, and a clean kit fragment passes them all.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { lintPage, prepare } from "../src/run.ts";
import { RULES } from "../src/rules.ts";
import { loadCatalog, refusalPatterns } from "../src/strings.ts";
import { REPO_ROOT } from "../src/config.ts";
import type { LintOptions, LintResult } from "../src/types.ts";

const REFUSALS = refusalPatterns(loadCatalog(REPO_ROOT));

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
  .card { border-radius: 22px; padding: 1.5rem; overflow: hidden; }
  .k-btn { font: 500 0.9375rem/1 Rubik; height: 44px; min-width: 96px; border: 0; border-radius: 12px;
    background: var(--c); color: var(--fg); }
  .k-btn:hover { background: var(--bg); }
  .k-btn:active { transform: scale(0.98); }
  .k-btn:disabled, .k-btn[aria-disabled="true"] { opacity: 0.42; }
  .k-btn:focus-visible { outline: 2px solid var(--c); outline-offset: 2px; }
  h1 { font: 600 1.75rem/2.125rem Rubik; margin: 0; text-wrap: balance; }
</style>`;

const page = (body: string) =>
  "data:text/html;base64," +
  Buffer.from(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">${BASE}</head><body><div data-shot="s">${body}</div></body></html>`,
  ).toString("base64");

async function lint(
  body: string,
  width = 1200,
  extra: LintOptions = {},
): Promise<LintResult> {
  const p = await browser.newPage({ viewport: { width, height: 900 } });
  await prepare(p);
  await p.goto(page(body));
  const r = await lintPage(p, { fonts: ["Rubik"], ...extra });
  await p.close();
  return r;
}

const SEEDED: Record<string, string> = {
  "border-width": `<div style="border: 2px solid var(--c)">Selected</div>`,
  "focus-visible-only": `<style>.b:focus { outline: 2px solid var(--c) }</style><button class="k-btn b">Go</button>`,
  "focus-ring-spread": `<style>.b:focus-visible { box-shadow: 0 0 0 4px var(--c) }</style><button class="k-btn b">Go</button>`,
  "button-glow": `<button class="k-btn" style="box-shadow: 0 6px 16px rgb(0 128 255 / 0.6)">Go</button>`,
  "font-family": `<p style="font-family: Arial">Hello</p>`,
  weights: `<p style="font-weight: 700">Hello</p>`,
  "px-font": `<style>.p { font-size: 15px }</style><p class="p">Hello</p>`,
  "spacing-off-scale": `<div style="padding: 13px">Hello</div>`,
  "polaris-mark": `<svg role="img" aria-label="Polaris Key" width="24" height="24"></svg>`,
  "mark-size": `<p data-part="powered-by"><svg role="img" aria-label="Polaris Key" width="12" height="12"></svg></p>`,
  "refusal-styling": `<style>:root { --pk-danger: rgb(220 50 50); }</style><p style="color: var(--pk-danger)">Sign out of Tidewater on another device, then try again.</p>`,
  "initial-focus": `<div data-pk-fullwindow><button class="k-btn">Go</button></div>`,
  "link-validation": `<a class="k-btn" href="http://example.com/x">Go</a>`,
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
  "native-accent-tint": `<style>:root { --pk-service-license: rgb(198 233 64); }</style><div data-ui-preset="native"><div style="border: 1px solid rgb(198 233 64)">Row</div></div>`,
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
  const OPTS: Record<string, LintOptions> = {
    "refusal-styling": { refusals: REFUSALS },
  };
  for (const [rule, body] of Object.entries(SEEDED)) {
    it(`fails on a seeded ${rule}`, async () => {
      const r = await lint(body, WIDTH[rule], OPTS[rule]);
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

  // Design language v2 (UK-55): what each rule must spare, and the second shape of those that have one.
  describe("design-language rules", () => {
    const rules = async (body: string, extra: LintOptions = {}) =>
      (await lint(body, 1200, extra)).violations.map((v) => v.rule);

    it("spacing-off-scale passes the scale, a hairline and a kit token", async () => {
      expect(
        await rules(
          `<style>:root { --pk-space-4: 1rem; --kit-pad: 0.75rem; }</style><div style="padding: var(--pk-space-4) 8px 0 1px; margin: 0 auto; gap: 12px"><p style="padding-inline: var(--kit-pad)">Hello</p></div>`,
        ),
      ).not.toContain("spacing-off-scale");
    });
    it("spacing-off-scale fails an authored margin and a flex gap", async () => {
      expect(await rules(`<p style="margin: 7px 0">Hello</p>`)).toContain(
        "spacing-off-scale",
      );
      expect(
        await rules(
          `<div style="display: flex; gap: 10px"><span>a</span><span>b</span></div>`,
        ),
      ).toContain("spacing-off-scale");
    });
    it("weights fails 300 and 800, spares 400 500 600", async () => {
      expect(await rules(`<p style="font-weight: 300">Hello</p>`)).toContain(
        "weights",
      );
      expect(await rules(`<p style="font-weight: 800">Hello</p>`)).toContain(
        "weights",
      );
      expect(
        await rules(
          `<p style="font-weight: 400">a</p><p style="font-weight: 500">b</p><p style="font-weight: 600">c</p>`,
        ),
      ).not.toContain("weights");
    });
    it("px-font spares rem and container units", async () => {
      expect(
        await rules(
          `<style>.p { font-size: 1rem } .q { font-size: clamp(0.875rem, 3cqi, 1.25rem) }</style><p class="p">a</p><p class="q">b</p>`,
        ),
      ).not.toContain("px-font");
    });
    it("polaris-mark spares the Powered-by badge and line", async () => {
      expect(
        await rules(
          `<p data-part="powered-by"><svg role="img" aria-label="Polaris Locker" width="24" height="24"></svg></p>`,
        ),
      ).not.toContain("polaris-mark");
    });
    it("mark-size fails 16 to 23 px that is not the favicon cut, spares the cut", async () => {
      const mark = (cut: string) =>
        `<p data-part="powered-by"><svg role="img" aria-label="Polaris Key" width="20" height="20" ${cut}></svg></p>`;
      expect(await rules(mark(""))).toContain("mark-size");
      expect(await rules(mark('data-cut="favicon"'))).not.toContain(
        "mark-size",
      );
    });
    it("refusal-styling fails a refusal beside an aria-invalid field, spares a neutral callout", async () => {
      const text = "Sign out of Tidewater on another device, then try again.";
      expect(
        await rules(
          `<div><input aria-invalid="true" aria-label="Key"><p>${text}</p></div>`,
          { refusals: REFUSALS },
        ),
      ).toContain("refusal-styling");
      expect(
        await rules(`<div><input aria-label="Key"><p>${text}</p></div>`, {
          refusals: REFUSALS,
        }),
      ).not.toContain("refusal-styling");
    });
    it("refusal-styling fails a refusal on a danger ground", async () => {
      expect(
        await rules(
          `<style>:root { --pk-danger-subtle: rgb(60 20 20); }</style><div style="background: var(--pk-danger-subtle)"><p>Sign out of Tidewater on another device, then try again.</p></div>`,
          { refusals: REFUSALS },
        ),
      ).toContain("refusal-styling");
    });
    it("initial-focus passes once focus is inside the kit root", async () => {
      const p = await browser.newPage({
        viewport: { width: 1200, height: 900 },
      });
      await prepare(p);
      await p.goto(
        page(`<div data-pk-fullwindow><button class="k-btn">Go</button></div>`),
      );
      await p.focus("button");
      const r = await lintPage(p, { fonts: ["Rubik"] });
      await p.close();
      expect(r.violations.map((v) => v.rule)).not.toContain("initial-focus");
    });
    it("link-validation fails window.open and javascript: / file: / data: links, spares https and loopback", async () => {
      for (const href of [
        "javascript:void(0)",
        "file:///etc/hosts",
        "data:text/html,x",
        "http://example.com/",
      ])
        expect(await rules(`<a class="k-btn" href="${href}">Go</a>`)).toContain(
          "link-validation",
        );
      expect(
        await rules(
          `<a class="k-btn" href="https://example.com/">Go</a><a class="k-btn" href="http://127.0.0.1:8787/cb">Back</a><a class="k-btn" href="#top">Top</a>`,
        ),
      ).not.toContain("link-validation");
      expect(
        await rules(
          `<script>function go(u) { window.open(u); }</script><p>Hello</p>`,
        ),
      ).toContain("link-validation");
    });
  });

  // UK-59: a "Built today" frame is a committed render, not a drawing.
  describe("tier-caption: Built today embeds a committed render", () => {
    const fig = (caption: string, shot: string) =>
      `<figure><figcaption>${caption}</figcaption><div data-shot="g">${shot}</div></figure>`;
    const tier = async (html: string) =>
      (await lint(html)).violations.filter((v) => v.rule === "tier-caption");

    it("fails a hand-drawn Built today frame", async () => {
      const v = await tier(fig("web · gate. Built today", "<p>Gate</p>"));
      expect(v).toHaveLength(1);
      expect(v[0]!.detail).toContain("committed render");
    });

    it("fails a Built today frame whose image is not a committed render", async () => {
      const v = await tier(
        fig(
          "web · gate. Built today",
          `<img src="shots/web-gate-dark.png" width="10" height="10" alt="">`,
        ),
      );
      expect(v).toHaveLength(1);
    });

    for (const src of [
      "../../../packages/sdk-react/test/visual/__screenshots__/Activate.parsed/1440-dark.png",
      "../../../sdks/swift/Tests/PolarisKeyUISnapshotTests/__Snapshots__/activate-parsed-dark.png",
      "../../../sdks/kotlin/ui/src/test/snapshots/sign-in/foldable-673x841-polaris-light.png",
      "../../../packages/sdk-node/test/cli/golden/gate-refused-needs-activation-dark.png",
      "shots/godot-built/gate-dark.png",
      "shots/ipad-built/Welcome.default-dark.jpg",
    ]) {
      it(`passes a Built today frame that embeds ${src.split("/").slice(-2).join("/")}`, async () => {
        expect(
          await tier(
            fig(
              "x · gate. Built today",
              `<img src="${src}" width="10" height="10" alt="">`,
            ),
          ),
        ).toEqual([]);
      });
    }

    it("passes a text frame that names its committed golden", async () => {
      expect(
        await tier(
          fig(
            "terminal · refusal. Built today (Node golden)",
            `<pre data-built-from="packages/sdk-node/test/cli/golden/ansi/gate-refused-needs-activation.ansi">x</pre>`,
          ),
        ),
      ).toEqual([]);
    });

    it("lets a hand-drawn UK-11 target stand alone", async () => {
      expect(
        await tier(fig("web · gate. UK-11 target", "<p>Gate</p>")),
      ).toEqual([]);
    });
  });

  // The patterns the built console and portal rely on, narrowed from false positives (B-233).
  it("spares a transparent colour, a relative colour, an image in flight, tinted art and a lone dash", async () => {
    const ok = await lint(
      `<style>
        .clear { background-color: transparent; color: currentColor; }
        .rel { background-color: color-mix(in oklab, var(--c), oklch(from var(--c) l c h / 0.5)); }
      </style>
      <p class="clear">Clear</p><p class="rel">Relative</p>
      <div style="display: flex"><span>—</span></div>
      <div data-art="fallback" style="inline-size: 40px; block-size: 40px; background-color: var(--c)"></div>`,
    );
    expect(ok.violations).toEqual([]);
  });

  it("fails a heavy edge, a black or white alpha colour and a cursor-only state", async () => {
    const r = await lint(
      `<style>
        .tab { border-bottom: 2px solid var(--c); }
        .rail { border-inline-start: 3px solid var(--c); }
        .dim { background-color: rgba(0, 0, 0, 0.6); }
        .ink { color: rgba(255, 255, 255, 0.7); }
        .c:hover:not(:disabled), .c:active:not(:disabled) { cursor: pointer; }
        .c:disabled { cursor: not-allowed; }
        .c:focus-visible { outline: 2px solid var(--c); }
      </style>
      <p class="tab">Tab</p><p class="rail">Rail</p><p class="dim">Dim</p><p class="ink">Ink</p>
      <button class="c">Cursor only</button>`,
    );
    const rules = r.violations.map((v) => v.rule);
    expect(
      rules.filter((x) => x === "border-width").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      rules.filter((x) => x === "colour-literal").length,
    ).toBeGreaterThanOrEqual(2);
    expect(rules).toContain("interactive-states");
  });

  it("lets a named allowance through for a spec'd heavy edge", async () => {
    const r = await lint(
      `<style>.tab { border-bottom: 2px solid var(--c); }</style><p class="tab" data-ui-allow="border-width">Tab (the selected tab's underline)</p>`,
    );
    expect(r.violations.map((v) => v.rule)).not.toContain("border-width");
  });

  it("reads a state rule written with :not() guards (Tailwind's hover:not-disabled)", async () => {
    const r = await lint(
      `<style>
        .t:hover:not(:disabled):not([aria-disabled="true"]) { background: var(--bg); }
        .t:active:not(:disabled, [aria-disabled="true"]) { transform: scale(0.98); }
        .t:disabled, .t[aria-disabled="true"] { opacity: 0.4; }
        .t:focus-visible { outline: 2px solid var(--c); }
      </style><button class="t">Go</button>`,
    );
    expect(r.violations.map((v) => v.rule)).not.toContain("interactive-states");
  });

  it("reads a state rule written with :is(:hover, :active) and :where()", async () => {
    const r = await lint(
      `<style>
        :where(.u):is(:hover, :active):not(:disabled, [aria-disabled="true"]) { opacity: 0.9; }
        :where(.u):is(:disabled, [aria-disabled="true"]) { opacity: 0.42; }
        .u:focus-visible { outline: 2px solid var(--c); }
      </style><a class="u" href="#x">Go</a>`,
    );
    expect(r.violations.map((v) => v.rule)).not.toContain("interactive-states");
  });

  it("measures a touch target as the press lands: a stretched link, a label, not a scroll region or a clipped control", async () => {
    const r = await lint(
      `<div data-ui-touch>
        <article style="position: relative; inline-size: 300px; block-size: 120px">
          <a href="#x" class="stretch" style="display: block; block-size: 20px">Open</a>
        </article>
        <label style="display: flex; align-items: center; block-size: 48px; min-inline-size: 120px"><input type="checkbox" style="inline-size: 16px; block-size: 16px"> Remember</label>
        <div role="region" aria-label="Scroll" tabindex="0" style="block-size: 16px; overflow: auto">Scroll region</div>
        <a href="#y" style="position: absolute; clip: rect(0, 0, 0, 0); inline-size: 1px; block-size: 1px; overflow: hidden">Skip</a>
        <span aria-hidden="true"><input type="checkbox" tabindex="-1" style="inline-size: 16px; block-size: 16px"></span>
        <p style="font-size: 14px">Read the <a href="#w">terms</a> first.</p>
        <button role="switch" aria-checked="false" class="sw" style="position: relative; inline-size: 36px; block-size: 20px; padding: 0; border: 0"></button>
        <style>.sw::after { content: ""; position: absolute; inset: -12px -4px; }</style>
        <style>.stretch::after { content: ""; position: absolute; inset: 0; }</style>
      </div>`,
    );
    expect(r.violations.filter((v) => v.rule === "touch-target")).toEqual([]);
    for (const bad of [
      `<a href="#z" style="display: block; block-size: 20px; inline-size: 80px">Small</a>`,
      // a lone link is a target, not a word in a sentence
      `<ul><li><a href="#out">Sign out</a></li></ul>`,
      // a decorative overlay that takes no press does not enlarge the target
      `<button class="d" style="position: relative; block-size: 20px; inline-size: 60px">Go</button><style>.d::after { content: ""; position: absolute; inset: -20px; pointer-events: none; }</style>`,
      // an overlay its own clipping box cuts away does not either
      `<button class="e" style="position: relative; overflow: hidden; block-size: 20px; inline-size: 60px">Go</button><style>.e::after { content: ""; position: absolute; inset: -20px; }</style>`,
      // a role=link tab stop and a clickable div are targets
      `<span role="link" tabindex="0" style="display: inline-block; block-size: 16px">Open</span>`,
      `<div role="option" tabindex="0" style="block-size: 16px">Pick</div>`,
    ]) {
      const small = await lint(`<div data-ui-touch>${bad}</div>`);
      expect(small.violations.map((v) => v.rule)).toContain("touch-target");
    }
  });

  it("spares an image still loading but not a broken one", async () => {
    const p = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await prepare(p);
    await p.route("https://img.test/slow.png", () => undefined); // never answers
    await p.route("https://img.test/gone.png", (r) => r.abort());
    await p.goto(
      page(
        `<img alt="slow" src="https://img.test/slow.png" width="40" height="40"><img alt="gone" src="https://img.test/gone.png" width="40" height="40">`,
      ),
      { waitUntil: "commit" },
    );
    await p.waitForTimeout(300);
    const r = await lintPage(p, { fonts: ["Rubik"] });
    await p.close();
    const empties = r.violations.filter((v) => v.rule === "empty-placeholder");
    expect(empties.length).toBe(1);
  });

  it("still fails a heavy box, an opaque literal and a coloured alpha", async () => {
    const r = await lint(
      `<style>.a { border: 2px solid var(--c); } .b { color: #000; } .c { background-color: rgba(255, 0, 0, 0.5); } .d { border-top: 2px solid var(--c); border-bottom: 2px solid var(--c); }</style>
      <p class="a">A</p><p class="b">B</p><p class="c">C</p><p class="d">D</p>
      <img alt="" width="40" height="40"><div data-art="fallback" style="inline-size: 40px; block-size: 40px"></div>`,
    );
    const rules = r.violations.map((v) => v.rule);
    expect(
      rules.filter((x) => x === "border-width").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      rules.filter((x) => x === "colour-literal").length,
    ).toBeGreaterThanOrEqual(2);
    expect(rules.filter((x) => x === "empty-placeholder").length).toBe(2);
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
