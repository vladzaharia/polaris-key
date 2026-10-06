// A tiny element builder for the prototypes: h("div.card#id", { attr: v, on: { click } }, ...kids).
// Strings become text nodes, so no markup is ever parsed from strings.
export function h(spec, attrs, ...kids) {
  if (
    attrs == null ||
    typeof attrs !== "object" ||
    attrs instanceof Node ||
    Array.isArray(attrs)
  ) {
    if (attrs != null) kids.unshift(attrs);
    attrs = {};
  }
  const [, tag = "div", rest = ""] = spec.match(/^([a-z0-9-]*)(.*)$/i);
  const el = document.createElement(tag || "div");
  for (const part of rest.match(/[.#][^.#]+/g) ?? []) {
    if (part[0] === ".") el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on")
      for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const SVG = "http://www.w3.org/2000/svg";
/** The success check: one stroke that draws once (motion.css .pk-check). */
export function check() {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 32 32");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("pk-check");
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", "M7 16.5l6 6L25 10");
  svg.append(p);
  return svg;
}
