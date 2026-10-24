// @pkey-feature ui.gate
//
// UK-31.8 kit fixes: the Rubik fallback carries a bold face, forced colours frame the panes (never
// a padding-less card), the provider's shape tokens reach the `:host` scales, the theme's custom
// properties never ride a `style` attribute (CSP), and focus lands in the app once the gate opens.

import { beforeAll, describe, expect, it } from "vitest";

import "../src/index.js";
import type { PkGate } from "../src/index.js";
import { fontFaceCss } from "../src/fonts.js";
import { stylesCss } from "../src/styles.js";
import { tokenCss } from "../src/tokens.js";
import { readMatrix, withDefaults } from "./fixtures.js";

const defaults = readMatrix().vocabulary.defaults;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});

describe("K2: the fallback face", () => {
  it("has a bold face for the weights Rubik carries", () => {
    const faces = fontFaceCss()
      .split("\n")
      .filter((f) => f.includes('"Rubik Fallback"'));
    expect(faces).toHaveLength(2);
    expect(faces.some((f) => /font-weight:550 900.*Arial Bold/.test(f))).toBe(
      true,
    );
  });
});

describe("K1: forced colours", () => {
  it("borders the panes, and the card only where it is not split or full-bleed", () => {
    const css = stylesCss();
    const block = css.slice(css.indexOf("@media (forced-colors: active)"));
    const rule = block.slice(0, block.indexOf("}"));
    expect(rule).toContain(".stage[data-split] .passport");
    expect(rule).not.toMatch(/^\s*\.card,/m);
    expect(rule).toContain(":not([data-fill])");
  });
});

describe("K7: provider tokens", () => {
  it("reads the provider's value under --pk-provider-* as the :host default", () => {
    const host = tokenCss().slice(0, tokenCss().indexOf("\n}"));
    expect(host).toMatch(
      /--pk-kit-radius-control: var\(--pk-provider-kit-radius-control, [^)]+\)/,
    );
    expect(host).toMatch(/--pk-font-sans: var\(--pk-provider-font-sans, /);
    expect(host).toMatch(/--pk-space-1: [\d.]+/);
  });
});

describe("K3 and K6: the gate element", () => {
  it("sets no style attribute on the kit root, and its custom properties through the CSSOM", async () => {
    const gate = document.createElement("pk-gate") as PkGate;
    gate.theme = { accent: "#2a8a7e" };
    // A `style` attribute is the CSP violation; the CSSOM (`style.setProperty`) is not.
    const set = Element.prototype.setAttribute;
    const styled: string[] = [];
    Element.prototype.setAttribute = function (name: string, v: string) {
      if (name === "style") styled.push(v);
      return set.call(this, name, v);
    };
    try {
      document.body.replaceChildren(gate);
      await gate.updateComplete;
    } finally {
      Element.prototype.setAttribute = set;
    }
    const root = gate.shadowRoot!.querySelector<HTMLElement>(".pk-root")!;
    expect(root).not.toBeNull();
    expect(styled).toEqual([]);
    expect(root.style.getPropertyValue("--pk-accent")).not.toBe("");
  });

  it("moves focus to the app when the gate opens with focus inside it, not on first render", async () => {
    const gate = document.createElement("pk-gate") as PkGate;
    gate.innerHTML = `<button id="app">app</button>`;
    gate.input = withDefaults(
      { gate: { status: "needs-activation" } },
      defaults,
    );
    document.body.replaceChildren(gate);
    await gate.updateComplete;
    expect(document.activeElement).toBe(document.body);

    // Focus inside the gate's own screen, then the licence holds.
    const inner = gate.shadowRoot!.querySelector<HTMLElement>("button, input");
    inner?.focus();
    gate.input = withDefaults({ gate: { status: "ok" } }, defaults);
    await gate.updateComplete;
    expect(inner).not.toBeNull();
    expect(document.activeElement?.id).toBe("app");
  });
});
