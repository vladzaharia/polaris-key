/**
 * Scroll regions that take focus only while they scroll (docs plan 8.5; WCAG 1.4.10 and 2.1.1).
 *
 * `scripts/console-parts.ts` writes every table region with `role`, `aria-label` and
 * `tabindex="0"`, so a page without this script still has a reachable, named region. Here a
 * region that fits loses all three (no tab stop, no ring, no empty landmark) and gets them back
 * when it overflows again. A code block's `pre` is named the same way, by its frame's title.
 */

const TABLE = "[data-pk-table]";
const CODE = ".expressive-code figure.frame pre";

function nameOf(el: Element): string {
  if (el.matches(TABLE))
    return (
      el.getAttribute("data-pk-label") ??
      el.getAttribute("aria-label") ??
      "Table"
    );
  const title = el
    .closest("figure")
    ?.querySelector(".header .title")
    ?.textContent?.trim();
  return title ? `${title} code` : "Code";
}

function sync(el: HTMLElement): void {
  const scrolls = el.scrollWidth > el.clientWidth + 1;
  if (scrolls) {
    el.setAttribute("role", "region");
    el.setAttribute(
      "aria-label",
      el.getAttribute("data-pk-label") ?? nameOf(el),
    );
    el.setAttribute("tabindex", "0");
  } else {
    el.removeAttribute("role");
    el.removeAttribute("aria-label");
    el.removeAttribute("tabindex");
  }
}

function start(): void {
  const regions = [
    ...document.querySelectorAll<HTMLElement>(`${TABLE}, ${CODE}`),
  ];
  // A region's name is unique on the page: repeat names get a number.
  const seen = new Map<string, number>();
  for (const el of regions) {
    const name = nameOf(el);
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    el.setAttribute("data-pk-label", n > 1 ? `${name} ${n}` : name);
  }
  if (typeof ResizeObserver === "undefined") return;
  const owner = new WeakMap<Element, HTMLElement>();
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const el = owner.get(entry.target);
      if (el) sync(el);
    }
  });
  for (const el of regions) {
    owner.set(el, el);
    observer.observe(el);
    // The content can outgrow the region without the region resizing (fonts, text zoom).
    const inner = el.firstElementChild;
    if (inner) {
      owner.set(inner, el);
      observer.observe(inner);
    }
    sync(el);
  }
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", start);
else start();
