// S-23 CSP probe: which motion mechanisms survive the Worker's exact console/portal CSP?
//
// Serves a tiny page with the CSP from packages/worker/src/securityHeaders.ts
// (`style-src 'self'`, `script-src 'self'`, no 'unsafe-inline') and, in Chromium, Firefox and
// WebKit, records for each mechanism: does it apply, and does it raise a
// `securitypolicyviolation` event?
//
//   mise exec node@22 -- node docs/research/2026-09-29-godot-omniplatform/prototype/motion/tools/csp-probe.mjs
//
// Needs the admin package's Playwright (pnpm install) and its browsers
// (`pnpm --filter @polaris-key/admin exec playwright install chromium firefox webkit`).
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../../../../", import.meta.url));
const require = createRequire(`${repo}packages/admin/package.json`);
const { chromium, firefox, webkit } = require("playwright");

// The console/portal shells' policy, minus the hashes for the pre-paint script (not needed here).
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/probe.css"><script src="/probe.js" defer></script></head>
<body><div id="a" class="box">a</div><div id="b" class="box">b</div><div id="c" class="box">c</div>
<div id="d" class="box">d</div><div id="e" class="box starting">e</div><dialog id="dlg">x</dialog>
<div id="f" class="box meter">f</div><button id="btn">click</button></body></html>`;

const CSS = `
.box{width:100px;height:20px;background:red}
.meter{transform:scaleX(var(--pk-meter,0));transform-origin:left}
.starting{transition:opacity 50ms; opacity:1}
@starting-style{.starting{opacity:0}}
::view-transition-old(root),::view-transition-new(root){animation-duration:30ms}
.slow-vt::view-transition-old(root),.slow-vt::view-transition-new(root){animation-duration:1500ms}
:root.slow-vt::view-transition-group(root){animation-duration:1500ms}
@property --pk-count{syntax:"<integer>";inherits:false;initial-value:0}
`;

const JS = `
const out = {};
const v = [];
document.addEventListener("securitypolicyviolation", (e) => v.push(e.violatedDirective + " " + (e.sample||"")));
const tick = () => new Promise((r) => setTimeout(r, 120));
window.run = async () => {
  // 1. CSSOM custom property (what React's style prop and el.style.setProperty use)
  const a = document.getElementById("a");
  a.style.setProperty("--pk-meter", "0.5");
  out.cssomCustomProp = getComputedStyle(a).getPropertyValue("--pk-meter").trim() === "0.5";
  // 2. CSSOM direct property
  const b = document.getElementById("b");
  b.style.opacity = "0.5";
  out.cssomOpacity = getComputedStyle(b).opacity === "0.5";
  // 3. style attribute through setAttribute (the markup path)
  const c = document.getElementById("c");
  c.setAttribute("style", "opacity:0.25");
  out.styleAttribute = getComputedStyle(c).opacity === "0.25";
  // 4. Web Animations API
  const d = document.getElementById("d");
  try {
    const anim = d.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 60, easing: "linear(0, 0.5 30%, 1)" });
    await anim.finished;
    out.waapi = true;
  } catch (e) { out.waapi = "error: " + e.message; }
  // 5. A <style> element (what sonner, Radix Select and style-mod used to inject)
  const s = document.createElement("style");
  s.textContent = "#d{outline:3px solid blue}";
  document.head.appendChild(s);
  out.styleElement = getComputedStyle(d).outlineStyle === "solid";
  // 6. Constructable stylesheet (src/lib/styleSingleton.ts's route)
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("#d{letter-spacing:3px}");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    out.constructableSheet = getComputedStyle(d).letterSpacing === "3px";
  } catch (e) { out.constructableSheet = "error: " + e.message; }
  // 7. view-transition-name through CSSOM, then a same-document View Transition
  d.style.viewTransitionName = "probe-d";
  out.viewTransitionNameCssom = getComputedStyle(d).viewTransitionName === "probe-d";
  if (typeof document.startViewTransition === "function") {
    try {
      const t = document.startViewTransition(() => { d.textContent = "d2"; });
      await t.finished;
      out.startViewTransition = true;
    } catch (e) { out.startViewTransition = "error: " + e.message; }
  } else out.startViewTransition = "unsupported";
  out.viewTransitionTypes = typeof document.startViewTransition === "function" &&
    (() => { try { return !!document.startViewTransition({ update(){}, types: ["x"] }).types; } catch { return false; } })();
  // 8. CSS features the system leans on
  out.startingStyle = CSS.supports("selector(:popover-open)") ? "popover ok" : "no popover";
  out.linearEasing = CSS.supports("transition-timing-function", "linear(0, 1)");
  out.allowDiscrete = CSS.supports("transition-behavior", "allow-discrete");
  out.interpolateSize = CSS.supports("interpolate-size", "allow-keywords");
  out.atProperty = typeof CSS.registerProperty === "function";
  out.scrollTimeline = CSS.supports("animation-timeline", "view()");
  out.vtMatchElement = CSS.supports("view-transition-name", "match-element");
  out.vtClass = CSS.supports("view-transition-class", "pk-row");
  out.siblingIndex = CSS.supports("animation-delay", "calc(sibling-index() * 1ms)");
  // 9. Is the page interactive while a view transition animates? Start a 1 s transition, then
  //    the harness clicks the button (a real input event) and we read whether its handler ran.
  if (typeof document.startViewTransition === "function") {
    const btn = document.getElementById("btn");
    window.__clicked = false;
    btn.addEventListener("click", () => { window.__clicked = true; });
    window.__vt = document.startViewTransition(() => { btn.textContent = "click!"; });
    await window.__vt.ready;
    document.documentElement.classList.add("slow-vt");
  }
  out.prefersReducedMotionQuery = matchMedia("(prefers-reduced-motion: reduce)").matches;
  await tick();
  out.violations = v.slice();
  return out;
};
`;

const server = createServer((req, res) => {
  const route = {
    "/": ["text/html", HTML],
    "/probe.css": ["text/css", CSS],
    "/probe.js": ["text/javascript", JS],
  }[req.url];
  if (!route) return res.writeHead(404).end();
  res.writeHead(200, {
    "content-type": route[0],
    "content-security-policy": CSP,
  });
  res.end(route[1]);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const results = {};
for (const [name, type] of Object.entries({ chromium, firefox, webkit })) {
  for (const reduced of [false, true]) {
    let browser;
    try {
      browser = await type.launch();
    } catch (e) {
      results[`${name}${reduced ? " (reduced)" : ""}`] =
        `not installed: ${e.message.split("\n")[0]}`;
      continue;
    }
    const ctx = await browser.newContext({
      reducedMotion: reduced ? "reduce" : "no-preference",
    });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForFunction(() => typeof window.run === "function");
    const r = await page.evaluate(() => window.run());
    // Click during the long transition (if one was started) and see whether the handler ran.
    const vtRunning = await page.evaluate(() => !!window.__vt);
    if (vtRunning) {
      await page.evaluate(() => {
        // a fresh, long transition so the click lands mid-animation
        window.__clicked = false;
        document.documentElement.classList.add("slow-vt");
        window.__vt2 = document.startViewTransition(() => {});
        return window.__vt2.ready;
      });
      await page.mouse.click(20, 200);
      await page
        .locator("#btn")
        .click({ force: true, timeout: 2000 })
        .catch(() => {});
      r.clickDuringViewTransition = await page.evaluate(() => window.__clicked);
      r.vtStillRunningAtClick = await page.evaluate(() =>
        document
          .getAnimations()
          .some((a) =>
            String(a.effect?.pseudoElement || "").includes("view-transition"),
          ),
      );
    }
    results[`${name} ${browser.version()}${reduced ? " (reduced)" : ""}`] = r;
    await browser.close();
  }
}
server.close();
console.log(JSON.stringify(results, null, 2));
