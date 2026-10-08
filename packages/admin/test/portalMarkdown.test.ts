import { describe, expect, it } from "vitest";
import {
  outline,
  parseInline,
  parseMarkdown,
  releaseNotes,
  safeHref,
  type Block,
  type Inline,
} from "../src/portal/model/markdown.js";

/**
 * What's new reads release notes as Markdown (owner polish 2026-10-07; PORTAL.md §4.20): a small
 * tree of blocks and inlines, never HTML, with only safe links, and a short summary before the
 * rest.
 */

/** The inlines' text, with each formatted run marked: **b**, _i_, ~~d~~, `c`, [t](href). */
function text(nodes: readonly Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.kind) {
        case "text":
          return n.text;
        case "code":
          return `\`${n.text}\``;
        case "strong":
          return `**${text(n.children)}**`;
        case "em":
          return `_${text(n.children)}_`;
        case "del":
          return `~~${text(n.children)}~~`;
        case "link":
          return `[${text(n.children)}](${n.href})`;
      }
    })
    .join("");
}

const kinds = (blocks: readonly Block[]) => blocks.map((b) => b.kind);

describe("release notes as Markdown", () => {
  it("reads headings, paragraphs, lists, quotes, code and rules", () => {
    const blocks = parseMarkdown(
      [
        "# 2.4.1",
        "",
        "A faster preset browser.",
        "Second line of the same paragraph.",
        "",
        "## Fixes",
        "- Rumble no longer cuts out",
        "* Steadier 40 fps",
        "",
        "+ Loose list item",
        "1. First",
        "2) Second",
        "> Quoted",
        "```",
        "pkey sync --force",
        "<b>not bold</b>",
        "```",
        "---",
      ].join("\n"),
    );
    expect(kinds(blocks)).toEqual([
      "heading",
      "p",
      "heading",
      "ul",
      "ol",
      "quote",
      "code",
      "hr",
    ]);
    const p = blocks[1] as Extract<Block, { kind: "p" }>;
    // A single newline is a line break, as GitHub shows release notes.
    expect(p.lines.map(text)).toEqual([
      "A faster preset browser.",
      "Second line of the same paragraph.",
    ]);
    const ul = blocks[3] as Extract<Block, { kind: "ul" }>;
    // Any bullet marker continues the list, across a blank line.
    expect(ul.items.map((i) => i.map(text).join(" / "))).toEqual([
      "Rumble no longer cuts out",
      "Steadier 40 fps",
      "Loose list item",
    ]);
    const ol = blocks[4] as Extract<Block, { kind: "ol" }>;
    expect(ol.start).toBe(1);
    expect(ol.items).toHaveLength(2);
    expect((blocks[6] as Extract<Block, { kind: "code" }>).text).toBe(
      "pkey sync --force\n<b>not bold</b>",
    );
  });

  it("keeps a loose list (blank lines between items) as one list, and continues an item on an indented line", () => {
    const blocks = parseMarkdown("- One\n\n- Two\n  more about two\n- Three");
    expect(kinds(blocks)).toEqual(["ul"]);
    const ul = blocks[0] as Extract<Block, { kind: "ul" }>;
    expect(ul.items.map((i) => i.map(text))).toEqual([
      ["One"],
      ["Two", "more about two"],
      ["Three"],
    ]);
  });

  it("drops an empty heading rather than drawing an empty one", () => {
    expect(kinds(parseMarkdown("##\nText"))).toEqual(["p"]);
  });

  it("reads bold, italic, strikethrough, code, links and escapes", () => {
    expect(
      text(
        parseInline(
          "**New** _Photo_ *Mode* ~~old~~ `pkey sync` [notes](https://ex.com/n) \\*literal\\*",
        ),
      ),
    ).toBe(
      "**New** _Photo_ _Mode_ ~~old~~ `pkey sync` [notes](https://ex.com/n) *literal*",
    );
    // snake_case and a lone star stay text.
    expect(text(parseInline("set max_offline_days to 3 * 2"))).toBe(
      "set max_offline_days to 3 * 2",
    );
    expect(text(parseInline("**bold _and italic_**"))).toBe(
      "**bold _and italic_**",
    );
  });

  it("links bare https URLs and autolinks, without the sentence's punctuation", () => {
    expect(
      text(
        parseInline(
          "Full changelog: https://github.com/acme/app/compare/v1...v2. Mail <mailto:help@acme.dev>.",
        ),
      ),
    ).toBe(
      "Full changelog: [https://github.com/acme/app/compare/v1...v2](https://github.com/acme/app/compare/v1...v2). Mail [mailto:help@acme.dev](mailto:help@acme.dev).",
    );
  });

  it("shows raw HTML as the text it is", () => {
    const nodes = parseInline(
      '<img src=x onerror="alert(1)"> <script>x</script>',
    );
    expect(nodes.every((n) => n.kind === "text")).toBe(true);
    expect(text(nodes)).toBe(
      '<img src=x onerror="alert(1)"> <script>x</script>',
    );
  });

  it("an image is its alt text: the notes never load a remote image", () => {
    expect(text(parseInline("![Photo Mode](https://cdn.ex.com/a.png)"))).toBe(
      "Photo Mode",
    );
  });

  it("keeps only safe links: https with no credentials, and mailto", () => {
    expect(safeHref("https://ex.com/a?b=1#c")).toBe("https://ex.com/a?b=1#c");
    expect(safeHref("mailto:help@ex.com")).toBe("mailto:help@ex.com");
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:x",
      "http://ex.com",
      "//ex.com/a",
      "/relative",
      "#anchor",
      "https://user:pass@ex.com",
      "mailto:nobody",
      "https://",
    ])
      expect(safeHref(bad), bad).toBeNull();
    // An unsafe link is its words, never an anchor.
    expect(parseInline("[click](javascript:alert(1))")).toEqual([
      { kind: "text", text: "click" },
    ]);
    // A link with no words reads as its address.
    expect(text(parseInline("[](https://ex.com)"))).toBe(
      "[https://ex.com](https://ex.com/)",
    );
  });

  it("places headings under the card's h2, never skipping a level", () => {
    const levels = (md: string) =>
      outline(parseMarkdown(md)).flatMap((b) =>
        b.kind === "heading" ? [b.level] : [],
      );
    expect(levels("# A\n## B\n### C")).toEqual([3, 4, 5]);
    expect(levels("## A\n#### B")).toEqual([3, 4]);
    // The deepest first: still an h3, then one level at a time.
    expect(levels("#### A\n## B\n#### C")).toEqual([3, 3, 4]);
    expect(levels("# A\n###### B")).toEqual([3, 4]);
  });

  it("a short summary first: the first paragraph or list, cut to three", () => {
    // Three bullets or fewer: all of it, nothing more to open.
    const short = releaseNotes("- One\n- Two\n- Three");
    expect(kinds(short.summary)).toEqual(["ul"]);
    expect(short.rest).toEqual([]);

    // More: three in the summary, the rest continues the list.
    const long = releaseNotes(
      "## Highlights\n- 1\n- 2\n- 3\n- 4\n- 5\n\nThanks!",
    );
    expect(kinds(long.summary)).toEqual(["heading", "ul"]);
    expect(
      (long.summary[1] as Extract<Block, { kind: "ul" }>).items,
    ).toHaveLength(3);
    expect(kinds(long.rest)).toEqual(["ul", "p"]);
    expect((long.rest[0] as Extract<Block, { kind: "ul" }>).items).toHaveLength(
      2,
    );

    // A numbered list keeps counting in the rest.
    const numbered = releaseNotes("1. a\n2. b\n3. c\n4. d");
    expect((numbered.rest[0] as Extract<Block, { kind: "ol" }>).start).toBe(4);

    // The first paragraph, then the rest of the notes.
    const para = releaseNotes("Faster preset browser.\n\n- Fix one\n- Fix two");
    expect(kinds(para.summary)).toEqual(["p"]);
    expect(kinds(para.rest)).toEqual(["ul"]);

    // A long paragraph: its first three lines.
    const lines = releaseNotes("a\nb\nc\nd\ne");
    expect(
      (lines.summary[0] as Extract<Block, { kind: "p" }>).lines,
    ).toHaveLength(3);
    expect((lines.rest[0] as Extract<Block, { kind: "p" }>).lines).toHaveLength(
      2,
    );

    // Only headings: all of it is the summary.
    expect(releaseNotes("# Title").rest).toEqual([]);
  });

  it("the summary and the rest are the whole notes", () => {
    const md =
      "# 1.4.2\nIntro line\n\n## New\n- a\n- b\n\n## Fixed\n1. c\n2. d\n> note\n```\ncode\n```";
    const { summary, rest } = releaseNotes(md);
    expect([...summary, ...rest]).toEqual(outline(parseMarkdown(md)));
  });

  it("reads a long or hostile input without stalling", () => {
    const hostile = `${"*_~`[".repeat(4000)}\n${"- ".repeat(2000)}`;
    const start = performance.now();
    parseMarkdown(hostile);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
