import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

/** The 404 page is one file for every door; under /docs/help/ an inline script makes it Locker's. */
const source = readFileSync(
  new URL("../src/components/help/MissingPage.astro", import.meta.url),
  "utf8",
);
const script = /<script is:inline>([\s\S]*?)<\/script>/.exec(source)![1]!;

function run(pathname: string) {
  const removed: string[] = [];
  let later: () => void = () => {};
  const attrs: Record<string, string> = {};
  const doc = {
    title: "Page not found | Polaris Key",
    documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) },
    querySelector: () => null,
    addEventListener: (_: string, fn: () => void) => (later = fn),
    querySelectorAll: (sel: string) => {
      removed.push(sel);
      return [{ remove: () => removed.push("removed") }];
    },
  };
  runInNewContext(script, { location: { pathname }, document: doc });
  later();
  return { doc, attrs, removed };
}

describe("MissingPage (docs.not-found)", () => {
  it("titles a Help miss Polaris Locker and drops the Key variant", () => {
    const { doc, attrs, removed } = run("/docs/help/anything-missing/");
    expect(doc.title).toBe("Page not found · Polaris Locker");
    expect(attrs).toHaveProperty("data-help-miss");
    expect(removed.join(" ")).toContain('data-miss-brand="key"');
    expect(removed.join(" ")).toContain("[data-miss-key]");
    expect(removed).toContain("removed");
  });
  it("leaves a docs miss alone", () => {
    const { doc, attrs } = run("/docs/anything-missing/");
    expect(doc.title).toBe("Page not found | Polaris Key");
    expect(attrs).toEqual({});
  });
});
