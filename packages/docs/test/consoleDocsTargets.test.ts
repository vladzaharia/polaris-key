/**
 * Each console page's Docs target (`docs` in packages/admin/src/console/nav.ts) is a live page
 * that names the screen: the page's label appears in the target's title, a heading or bold text.
 * The worker's docsLinks test checks that the page exists in the built site; this checks that it
 * is about the screen.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readNav } from "../scripts/console-nav.mjs";
import { fileFor, splitFrontmatter } from "../scripts/site-map.mjs";

const nav = readNav();
const pages = [
  ...nav.globals,
  ...nav.sections.flatMap((s) => s.items),
  ...nav.platform,
].filter((p) => p.inNav);

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function target(href: string): {
  title: string;
  body: string;
  status?: string;
} {
  const id = href
    .replace(/#.*$/, "")
    .replace(/^\/docs\//, "")
    .replace(/\/$/, "");
  const file = fileFor(id) ?? fileFor(`${id}/index`);
  if (file === null) throw new Error(`${href}: no such docs page`);
  const { data, body } = splitFrontmatter(readFileSync(file, "utf8"));
  return {
    title: String(data.title ?? ""),
    body,
    status: data.status as string | undefined,
  };
}

describe("console Docs targets", () => {
  it("reads the nav table", () => {
    expect(nav.sections.length).toBeGreaterThan(5);
    expect(pages.length).toBeGreaterThan(30);
  });

  for (const p of pages) {
    it(`${p.label} (${p.path || "root"}) opens a page that names it`, () => {
      expect(p.docs, `${p.page} has no docs target`).toBeTruthy();
      const t = target(p.docs!);
      expect(t.status, `${p.docs} is a stub`).not.toBe("stub");
      const word = escape(p.label!);
      const named =
        new RegExp(`\\b${word}\\b`, "i").test(t.title) ||
        new RegExp(`\\*\\*[^*\\n]*\\b${word}\\b[^*\\n]*\\*\\*`, "i").test(
          t.body,
        ) ||
        new RegExp(`^#{2,4} .*\\b${word}\\b`, "im").test(t.body);
      expect(named, `${p.docs} never names "${p.label}"`).toBe(true);
    });
  }
});
