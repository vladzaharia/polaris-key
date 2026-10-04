import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  splitRules,
  styleSingleton,
  stylesheetSingleton,
} from "../src/lib/styleSingleton.js";

/**
 * The CSP-safe react-style-singleton shim (vite.config.ts alias). Radix's scroll lock applies its
 * CSS through it; the Worker's `style-src 'self'` blocks inline <style>, so the shim must never
 * create one, and must keep the package's reference counting.
 */

/** A constructable-stylesheet stand-in that records what was applied. */
class FakeSheet {
  css = "";
  replaceSync(css: string): void {
    this.css = css;
  }
}

function installConstructable(): { sheets: () => FakeSheet[] } {
  vi.stubGlobal("CSSStyleSheet", FakeSheet);
  let adopted: FakeSheet[] = [];
  Object.defineProperty(document, "adoptedStyleSheets", {
    configurable: true,
    get: () => adopted,
    set: (v: FakeSheet[]) => {
      adopted = v;
    },
  });
  return { sheets: () => adopted };
}

const styleCount = (): number => document.querySelectorAll("style").length;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (document as unknown as { adoptedStyleSheets?: unknown })
    .adoptedStyleSheets;
  document.head.innerHTML = "";
});

describe("constructable stylesheets (the normal path)", () => {
  it("applies once for the first user, removes after the last, and never adds a <style>", () => {
    const { sheets } = installConstructable();
    const before = styleCount();
    const s = stylesheetSingleton();
    s.add("body { overflow: hidden }");
    s.add("body { overflow: hidden }");
    expect(sheets()).toHaveLength(1);
    expect(sheets()[0]!.css).toBe("body { overflow: hidden }");
    s.remove();
    expect(sheets()).toHaveLength(1);
    s.remove();
    expect(sheets()).toHaveLength(0);
    expect(styleCount()).toBe(before);
  });

  it("leaves other adopted sheets alone", () => {
    const { sheets } = installConstructable();
    const other = new FakeSheet();
    document.adoptedStyleSheets = [other as unknown as CSSStyleSheet];
    const s = stylesheetSingleton();
    s.add("a { color: red }");
    expect(sheets()).toHaveLength(2);
    s.remove();
    expect(sheets()).toEqual([other]);
  });

  it("the component applies while mounted, shared across instances", () => {
    const { sheets } = installConstructable();
    const Style = styleSingleton();
    const a = render(<Style styles="html { overflow: hidden }" />);
    const b = render(<Style styles="html { overflow: hidden }" />);
    expect(sheets()).toHaveLength(1);
    a.unmount();
    expect(sheets()).toHaveLength(1);
    b.unmount();
    expect(sheets()).toHaveLength(0);
    expect(styleCount()).toBe(0);
  });
});

describe("the insertRule fallback (no constructable stylesheets)", () => {
  it("inserts into an existing sheet and deletes exactly its own rules", () => {
    vi.stubGlobal("CSSStyleSheet", undefined);
    // The app's own stylesheet, standing in for the linked styles.css.
    const host = document.createElement("style");
    host.textContent = "p { color: blue }";
    document.head.appendChild(host);
    const sheet = host.sheet!;
    const before = styleCount();

    const s = stylesheetSingleton();
    s.add("body { overflow: hidden } .x { margin: 0 }");
    expect(sheet.cssRules).toHaveLength(3);
    expect(styleCount()).toBe(before);
    s.remove();
    expect(sheet.cssRules).toHaveLength(1);
    expect(sheet.cssRules[0]!.cssText).toContain("color: blue");
  });

  it("does nothing (and creates nothing) when there is no sheet to use", () => {
    vi.stubGlobal("CSSStyleSheet", undefined);
    const s = stylesheetSingleton();
    s.add("body { overflow: hidden }");
    s.remove();
    expect(styleCount()).toBe(0);
  });
});

describe("splitRules", () => {
  it("splits top-level rules, nested blocks intact", () => {
    expect(
      splitRules("a{b:c} @media (min-width: 1px) { .x { y: z } }\n .q{r:s}"),
    ).toEqual(["a{b:c}", "@media (min-width: 1px) { .x { y: z } }", ".q{r:s}"]);
  });
});
