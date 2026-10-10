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
 * The lint's rules the built console and portal still break on every page at every size: the
 * colour, weight, RTL, state and one-primary rules the mockup boards and kits were written for.
 * UK-63 clears them and deletes this list; until then every OTHER rule (and any new one) must be
 * clean at the wide and zoomed sizes.
 */
export const LINT_DEBT_RULES = new Set([
  "colour-literal",
  "font-weight-700",
  "interactive-states",
  "rtl-physical",
  "focus-ring-spread",
  "border-width",
  "no-vw",
  "one-primary",
  "text-size-floor",
  "tier-separator",
  "empty-placeholder",
  "touch-target",
  // The console's own: sidebar group labels, a focus ring on :focus, a close X beside Cancel.
  "button-uppercase",
  "focus-visible-only",
  "x-beside-cancel",
  // A button's focus ring and a font mid-swap, caught in a transition: not a size effect.
  "button-glow",
  "font-family",
]);

/**
 * What `pnpm ui:lint --html` finds on the page outside {@link LINT_DEBT_RULES}, one
 * `rule: target detail` line each.
 */
export async function lintFindings(page: Page): Promise<string[]> {
  // Evaluated over the DevTools protocol, which the page's CSP does not govern (`lintPage`
  // would inject a script tag, which the policy blocks).
  await page.evaluate(LINT_SCRIPT);
  const { violations } = await lintPage(page, { scope: "body" });
  return (
    violations
      .filter((v) => !LINT_DEBT_RULES.has(v.rule))
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
