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
  const replaced: string[] = [];
  const h1: { id: string } = { id: "" };
  // The head's tab icons, as the build writes them (the Key's), plus one the script must not touch.
  const icons = [
    "/docs/branding/key/favicon.svg",
    "/docs/branding/key/favicon.ico",
    "/docs/branding/key/app-icon-dark-180.png",
    "https://example.test/other.png",
  ].map((href) => {
    const el = {
      href,
      getAttribute: (k: string) => (k === "href" ? el.href : null),
      setAttribute: (k: string, v: string) => {
        if (k === "href") el.href = v;
      },
    };
    return el;
  });
  const doc = {
    title: "Page not found · Polaris Key",
    documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) },
    querySelector: (sel: string) => (sel === ".pk-miss__help h1" ? h1 : null),
    addEventListener: (_: string, fn: () => void) => (later = fn),
    querySelectorAll: (sel: string) => {
      if (sel.includes('rel~="icon"')) return icons;
      removed.push(sel);
      return [{ remove: () => removed.push("removed") }];
    },
  };
  runInNewContext(script, {
    location: { pathname, replace: (to: string) => replaced.push(to) },
    document: doc,
  });
  later();
  return { doc, attrs, removed, replaced, h1, icons };
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
  it("gives the Help heading the skip link's target once the Key one is removed", () => {
    expect(run("/docs/help/anything-missing/").h1.id).toBe("_top");
  });
  it("forwards an unknown message code to the messages page", () => {
    expect(run("/docs/help/code/brand_new_code/").replaced).toEqual([
      "/docs/help/messages/?code=brand_new_code",
    ]);
    expect(run("/docs/help/nope/").replaced).toEqual([]);
    expect(run("/docs/code/x/").replaced).toEqual([]);
  });
  it("points a Help miss's tab icons at the Locker's", () => {
    const { icons } = run("/docs/help/anything-missing/");
    expect(icons.map((i) => i.href)).toEqual([
      "/docs/branding/locker/favicon.svg",
      "/docs/branding/locker/favicon.ico",
      "/docs/branding/locker/apple-touch-icon.png",
      "https://example.test/other.png",
    ]);
    expect(run("/docs/anything-missing/").icons[0]!.href).toBe(
      "/docs/branding/key/favicon.svg",
    );
  });
  it("leaves a docs miss alone", () => {
    const { doc, attrs } = run("/docs/anything-missing/");
    expect(doc.title).toBe("Page not found · Polaris Key");
    expect(attrs).toEqual({});
  });
});
