// The string lint over an element's render (UI-KITS.md §4.7, §7.3), shared by matrix.test.ts: every
// visible string of a ui-matrix.json component row is a catalog message (ICU arguments matched as
// wildcards), a documented platform variant, or an allowed fixture string. Uses ui-qa's matcher,
// the one the mockup boards run through `pnpm ui:lint`.

import { join } from "node:path";

import {
  allowed,
  compile,
  loadAllow,
  loadCatalog,
  matchString,
  nearest,
} from "../../ui-qa/src/strings.ts";
import { REPO } from "./fixtures.js";
import type { PkElement } from "../src/index.js";

const catalog = loadCatalog(REPO);
const matchers = compile(catalog);
const allow = loadAllow(join(REPO, "packages/ui-qa/rules/strings.allow.json"));

/**
 * The text a person reads, one string per element: its direct text, with an inline `<bdi>` (someone's
 * own text inside a sentence) joined in place. Shadow roots of nested elements are walked too.
 */
/** Inline marks inside a sentence: someone's own text (`bdi`) and a reason's bold lead (`strong`). */
const INLINE: ReadonlySet<string> = new Set(["bdi", "strong"]);

function visibleStrings(root: ShadowRoot): string[] {
  const out: string[] = [];
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const walk = (node: Node): void => {
    if (node instanceof Element) {
      if (["style", "svg", "script"].includes(node.localName)) return;
      if (node.getAttribute("aria-hidden") === "true") return;
      if (node.shadowRoot) walk(node.shadowRoot);
      const own = [...node.childNodes]
        .map((n) =>
          n.nodeType === Node.TEXT_NODE
            ? (n.textContent ?? "")
            : n instanceof Element && INLINE.has(n.localName)
              ? (n.textContent ?? "")
              : "",
        )
        .join("");
      const t = clean(own);
      if (t) out.push(t);
      node.childNodes.forEach((n) => {
        if (n instanceof Element && !INLINE.has(n.localName)) walk(n);
      });
      return;
    }
    node.childNodes.forEach(walk);
  };
  walk(root);
  return out;
}

// Known gap, not an allowance: the corpus's Activate/done rows carry no `activation.tier` or
// `term`, so the verdict line keeps its {tier} and {term}. The fixtures are plan-mode (UK-02b);
// recorded in UK-04's continuation note.
const FIXTURE_GAPS = [/\{tier\} · \{term\}$/u];

/** The visible strings of the element that the catalog, the platform variants and the allow list do not hold. */
export function stringsOutsideCatalog(el: PkElement): string {
  const platform =
    (el.input.platform as { os?: string } | undefined)?.os ?? "web";
  const bad: string[] = [];
  for (const text of visibleStrings(el.shadowRoot!)) {
    if (FIXTURE_GAPS.some((g) => g.test(text))) continue;
    // A wildcard match can hide an argument the kit never filled. These are the ones the
    // kit fills itself; {tier}, {size}, {time}… come from the adapter's data, and the corpus
    // rows leave them out (see FIXTURE_GAPS).
    if (
      /\{(store|provider|platform|device|thisDevice|developer|product)\}/.test(
        text,
      )
    ) {
      bad.push(`"${text}" (unfilled argument)`);
      continue;
    }
    if (matchString(matchers, text, platform)) continue;
    if (allowed(allow, text, "elements")) continue;
    const near = nearest(catalog, text);
    bad.push(`"${text}"${near ? ` (catalog: ${near.key})` : ""}`);
  }
  return bad.join(" | ");
}
