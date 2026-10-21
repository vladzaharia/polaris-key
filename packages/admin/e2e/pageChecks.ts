import type { Page } from "playwright";
import { LINT_SCRIPT, lintPage } from "../../ui-qa/src/index.ts";

/**
 * Checks shared by the console and portal e2e suites (owner direction 2026-10-08: wide windows
 * and 200 % zoom; WCAG 1.4.10).
 */

/**
 * Tables that scroll sideways outside a labelled, focusable region (WCAG 1.4.10 and 2.1.1: a dense
 * table scrolls only inside `role=region` with an accessible name and `tabindex=0`). A strip of
 * links or tabs that scrolls is not a table: its items take focus, which axe's
 * `scrollable-region-focusable` already checks. A named grid whose cells take focus (the ARIA
 * grid pattern's one tab stop, src/ui/Grid.tsx) is the same: its arrow keys scroll it, and a tab
 * stop on its scroller would break the pattern. Code blocks and form controls are excused.
 */
export function unlabelledScrollers(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll("*")) {
      if (el === document.documentElement || el === document.body) continue;
      if (el.matches("pre, code, input, textarea, select, option")) continue;
      if (el.closest("pre, [inert], [aria-hidden=true]")) continue;
      const cs = getComputedStyle(el);
      if (cs.overflowX !== "auto" && cs.overflowX !== "scroll") continue;
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      if (
        !el.matches("table, [role=table], [role=grid], [role=treegrid]") &&
        !el.querySelector("table, [role=table], [role=grid], [role=treegrid]")
      )
        continue;
      if (!el.checkVisibility({ visibilityProperty: true })) continue;
      const grid = "[role=grid]:is([aria-label], [aria-labelledby])";
      if (
        el.matches(grid)
          ? el.querySelector('[tabindex="0"]')
          : el.querySelector(`${grid} [tabindex="0"]`)
      )
        continue;
      const named =
        el.getAttribute("role") === "region" &&
        (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")) &&
        el.getAttribute("tabindex") === "0";
      if (!named)
        out.push(
          `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""} ${el.scrollWidth}>${el.clientWidth}`,
        );
    }
    return out;
  });
}

/**
 * The blocks matched by `selector` that break the content column: wider than `max`, or off the
 * window's centre by more than 2 px (a narrow column pinned to one side leaves an empty half
 * beside it). One line per block.
 */
export function columnBreaches(
  page: Page,
  selector: string,
  max: number,
  centred = true,
): Promise<string[]> {
  return page.evaluate(
    ({ selector, max, centred }) => {
      const out: string[] = [];
      const mid = document.documentElement.clientWidth / 2;
      for (const el of document.querySelectorAll(selector)) {
        if (!el.checkVisibility({ visibilityProperty: true })) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        const label = `${el.tagName.toLowerCase()} ${Math.round(r.left)}..${Math.round(r.right)}`;
        if (r.width > max + 0.5) out.push(`${label} is wider than ${max}`);
        else if (centred && Math.abs((r.left + r.right) / 2 - mid) > 2)
          out.push(`${label} is not centred (window centre ${mid})`);
      }
      return out;
    },
    { selector, max, centred },
  );
}

/**
 * Under forced colours, the controls with no visible boundary and the selected states with no 2 px
 * border: one line each. A control needs a border or an outline of at least 1 px; a selected tab,
 * radio card or pressed toggle needs 2 px (the non-colour cue that survives the palette swap).
 */
export function forcedColourBreaches(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const visible = (el: Element) =>
      el.checkVisibility({ visibilityProperty: true }) &&
      !el.closest("[inert], [aria-hidden=true]");
    const name = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[${el.getAttribute("role")}]` : ""} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 30)}"`;
    const edge = (cs: CSSStyleDeclaration) =>
      Math.max(
        ...["Top", "Right", "Bottom", "Left"].map((side) => {
          const style = cs.getPropertyValue(
            `border-${side.toLowerCase()}-style`,
          );
          const width = parseFloat(
            cs.getPropertyValue(`border-${side.toLowerCase()}-width`),
          );
          return style === "none" || style === "hidden" ? 0 : width;
        }),
        cs.outlineStyle === "none" ? 0 : parseFloat(cs.outlineWidth),
      );
    const controls =
      "button:not([data-variant=ghost]):not([role=tab]), input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea, [role=radio], [role=tab]";
    for (const el of document.querySelectorAll(controls)) {
      if (!visible(el)) continue;
      if (el.matches(".sr-only, .pk-sr-only") || el.closest(".sr-only"))
        continue;
      if (edge(getComputedStyle(el)) < 1)
        out.push(`${name(el)} has no visible boundary`);
    }
    const selected =
      "[role=tab][aria-selected=true], [role=tab][data-state=active], [role=radio][aria-checked=true], [role=radio][data-state=checked], [aria-pressed=true]";
    for (const el of document.querySelectorAll(selected)) {
      if (!visible(el)) continue;
      // An underline tab marks its selection with a 2 px bottom border, which counts.
      if (edge(getComputedStyle(el)) < 2)
        out.push(`${name(el)} is selected with no 2 px border`);
    }
    return out;
  });
}

/**
 * Every rule of `pnpm ui:lint --html` over the page, one `rule: target detail` line each.
 */
export async function lintFindings(
  page: Page,
  /**
   * Check touch targets too: `minTouch` is the smallest side in px (24 for the console, WCAG 2.5.8;
   * 44 for the customer site's touch layout, below the `desk` breakpoint).
   */
  targets?: { minTouch: number },
): Promise<string[]> {
  // Evaluated over the DevTools protocol, which the page's CSP does not govern (`lintPage`
  // would inject a script tag, which the policy blocks).
  await page.evaluate(LINT_SCRIPT);
  const { violations } = await lintPage(page, {
    scope: "body",
    ...(targets ? { touch: ["body"], minTouch: targets.minTouch } : {}),
  });
  return (
    violations
      // A line-clamped title is customer content cut at two lines; its tail is not drawn, and
      // `text-wrap: balance` does not apply to a clamped box.
      .filter(
        (v) => !(v.rule === "orphan" && v.target.includes(".line-clamp-")),
      )
      .map((v) => `${v.rule}: ${v.target} ${v.detail}`)
  );
}

/**
 * BRAND.md §7.7: a page-level first-run empty state carries the stationary star, upright and
 * still (no rotation, no running animation). One line per state that does not. The inline variant
 * (a compact block inside a card) has no star by design.
 */
export function emptyStateStarBreaches(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll("[data-empty=first-run]")) {
      if (!el.checkVisibility({ visibilityProperty: true })) continue;
      // The page-level state centres its content; the card variant is left-aligned.
      if (getComputedStyle(el).alignItems !== "center") continue;
      const star = el.querySelector("[data-stationary-star]");
      if (!star) {
        out.push("a first-run empty state has no stationary star");
        continue;
      }
      for (const e of [star, ...star.querySelectorAll("*")]) {
        const t = getComputedStyle(e).transform;
        if (t !== "none") out.push(`the star is transformed (${t})`);
        if (e.getAnimations().some((a) => a.playState === "running"))
          out.push("the star is animated");
      }
    }
    return out;
  });
}

/**
 * An unfilled catalog argument that reached the screen (`{org}`, `{product}`): any `{word}` in
 * the page's visible text. The quality bar runs it on every state.
 */
export function rawPlaceholders(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.body.innerText.matchAll(/\{[a-zA-Z]+\}/g), (m) => m[0]),
  );
}

/**
 * The console shell v2's state colours, measured on the render (ST-48; B2, B4, B17): the canvas's
 * 3 px rule and the tab indicator against the surface they sit on (UI 3:1), the primary's label
 * on its neutral ink (text 4.5:1), the focus ring being the nearest service's state ring, and no
 * element in the shell's chrome painted with a gradient or a coloured shadow (B6). One line per
 * breach.
 */
export function shellStateBreaches(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const rgb = (c: string): [number, number, number, number] | null => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1]!
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
      return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
    };
    const lum = (c: [number, number, number, number]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const ratio = (a: string, b: string): number | null => {
      const x = rgb(a);
      const y = rgb(b);
      if (!x || !y) return null;
      const [hi, lo] = [lum(x), lum(y)].sort((m, n) => n - m) as [
        number,
        number,
      ];
      return (hi + 0.05) / (lo + 0.05);
    };
    const main = document.getElementById("content");
    if (!main) return out;
    const mcs = getComputedStyle(main);
    const rule = ratio(mcs.borderTopColor, mcs.backgroundColor);
    if (rule !== null && rule < 3)
      out.push(
        `the canvas rule is ${rule.toFixed(2)}:1 on the canvas (UI 3:1)`,
      );
    const indicator = main.querySelector<HTMLElement>("[data-tab-indicator]");
    if (indicator) {
      const r = ratio(
        getComputedStyle(indicator).borderBottomColor,
        mcs.backgroundColor,
      );
      if (r !== null && r < 3)
        out.push(`the tab indicator is ${r.toFixed(2)}:1 (UI 3:1)`);
    }
    for (const b of main.querySelectorAll<HTMLElement>(
      '[data-variant="primary"]:not(:disabled):not([aria-disabled="true"])',
    )) {
      if (!b.checkVisibility()) continue;
      const s = getComputedStyle(b);
      const r = ratio(s.color, s.backgroundColor);
      if (r !== null && r < 4.5)
        out.push(
          `a primary's label is ${r.toFixed(2)}:1 on its ink (text 4.5:1)`,
        );
      const bg = rgb(s.backgroundColor);
      const ink = rgb(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--pk-action",
        ),
      );
      if (
        bg &&
        ink &&
        (Math.abs(bg[0] - ink[0]) > 40 || Math.abs(bg[1] - ink[1]) > 40)
      )
        out.push(
          `a primary is ${s.backgroundColor}, not the neutral action ink ${getComputedStyle(document.documentElement).getPropertyValue("--pk-action").trim()}`,
        );
      break;
    }
    // The focus ring follows the element's service: --pk-focus resolves to --pk-state-ring.
    for (const el of [
      main,
      ...Array.from(main.querySelectorAll("[data-service]")).slice(0, 6),
    ]) {
      const s = getComputedStyle(el);
      const f = s.getPropertyValue("--pk-focus").trim();
      const w = s.getPropertyValue("--pk-state-ring").trim();
      if (f !== w)
        out.push(
          `the focus ring ${f} is not the state ring ${w} under data-service=${el.getAttribute("data-service")}`,
        );
    }
    for (const el of main.querySelectorAll<HTMLElement>(
      "header[data-masthead] *, [data-card-header], [data-workbench-toolbar]",
    )) {
      const s = getComputedStyle(el);
      if (/gradient/.test(s.backgroundImage))
        out.push("a gradient in product chrome");
      if (s.boxShadow !== "none" && /oklch|color-mix/.test(s.boxShadow))
        out.push(`a coloured shadow: ${s.boxShadow.slice(0, 60)}`);
    }
    return out;
  });
}
