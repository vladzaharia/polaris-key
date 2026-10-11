// The light-DOM stylesheet React renders with (UI-KITS.md §3.2): every rule anchored to a kit root,
// nothing on `:root` or a bare element, everything in `@layer polaris-key`, and the shadow sheet's
// specificity kept inside the kit.

import { describe, expect, it } from "vitest";

import {
  lightDomCss,
  scopeCss as scopeRaw,
  stylesCss,
} from "../src/contract.js";

/** The rewrite with its whitespace collapsed (the bodies keep theirs). */
const scopeCss = (css: string) => scopeRaw(css).replace(/\s+/g, " ").trim();

/** Every qualified rule's selectors, with the at-rules that hold them. */
function selectors(css: string): string[] {
  const out: string[] = [];
  const re = /([^{};]+)\{/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const head = m[1]!.trim();
    if (head.startsWith("@") || /^(from|to|\d+%)$/.test(head)) continue;
    out.push(...head.split(",\n").map((s) => s.trim()));
  }
  return out;
}

describe("the light-DOM stylesheet", () => {
  const css = lightDomCss();

  it("anchors every selector to a kit root", () => {
    for (const s of selectors(css))
      expect(
        s.startsWith(".pk-root") || s.startsWith(":where(.pk-root)"),
        s,
      ).toBe(true);
  });

  it("sets nothing on :root or :host, and keeps keyframes as they are", () => {
    expect(css).not.toMatch(/:root|:host/);
    expect(css).toMatch(/@keyframes pk-sweep \{\s*from \{/);
  });

  it("puts every rule, tokens included, in @layer polaris-key", () => {
    // The sheet is two layer blocks: the tokens, then the kit's rules.
    const top = css.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    let depth = 0;
    const blocks: string[] = [];
    let start = 0;
    for (let i = 0; i < top.length; i++) {
      if (top[i] === "{") {
        if (depth === 0) blocks.push(top.slice(start, i).trim());
        depth++;
      } else if (top[i] === "}") {
        depth--;
        if (depth === 0) start = i + 1;
      }
    }
    expect(blocks).toEqual(["@layer polaris-key", "@layer polaris-key"]);
    expect(stylesCss().trim().startsWith("@layer polaris-key {")).toBe(true);
  });

  it("keeps the shadow sheet's specificity inside the kit", () => {
    expect(scopeCss(".btn[data-variant=primary] { color: red; }")).toBe(
      ":where(.pk-root) .btn[data-variant=primary] { color: red; }",
    );
    expect(scopeCss("h1,\nh2 { margin: 0; }")).toBe(
      ":where(.pk-root) h1, :where(.pk-root) h2 { margin: 0; }",
    );
    expect(scopeCss(":host([bare]) .pane { padding: 0; }")).toBe(
      ".pk-root[data-bare] .pane { padding: 0; }",
    );
    expect(scopeCss('[data-theme="dark"] .ambient img { opacity: 1; }')).toBe(
      '.pk-root[data-theme="dark"] .ambient img { opacity: 1; }',
    );
    expect(
      scopeCss("@container pk (max-width: 1rem) { .card { inset: 0; } }"),
    ).toBe(
      "@container pk (max-width: 1rem) { :where(.pk-root) .card { inset: 0; } }",
    );
  });

  it("drops comments, whose commas are not selectors", () => {
    expect(scopeCss("/* a, b { c } */ .x { y: z; }")).toBe(
      ":where(.pk-root) .x { y: z; }",
    );
  });
});
