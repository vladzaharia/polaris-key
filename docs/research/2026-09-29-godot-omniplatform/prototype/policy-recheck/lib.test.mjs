// Offline tests for the extraction and matching helpers: node --test lib.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  changelogDates,
  doccToText,
  hasQuote,
  htmlToText,
  mdToText,
  newerChangelogEntries,
  norm,
  parseRows,
} from "./lib.mjs";

test("norm folds smart quotes, dashes, nbsp and whitespace", () => {
  assert.equal(
    norm("Google Play’s  update mechanism — x"),
    "Google Play's update mechanism - x",
  );
});

test("htmlToText keeps the article, drops chrome, joins cells", () => {
  const html =
    "<nav>menu</nav><article><p>One</p><table><tr><td>7</td><td>August 31, 2026</td></tr></table></article><footer>f</footer>";
  const text = htmlToText(html);
  assert.ok(!text.includes("menu") && !text.includes("f\n"));
  assert.ok(hasQuote(text, "7 | August 31, 2026 |"));
});

test("hasQuote ignores line wrapping but not wording", () => {
  assert.ok(
    hasQuote("the deadline\n only applies", "the deadline only applies"),
  );
  assert.ok(
    !hasQuote("the deadline only applies", "the deadline no longer applies"),
  );
});

test("mdToText strips emphasis and code marks", () => {
  assert.ok(
    hasQuote(
      mdToText("Installer URLs use **HTTPS** (not plain HTTP)."),
      "Installer URLs use HTTPS (not plain HTTP).",
    ),
  );
});

test("doccToText reads text and codeVoice nodes", () => {
  const json = {
    primaryContentSections: [
      {
        content: [
          {
            type: "paragraph",
            inlineContent: [
              { type: "text", text: "Use " },
              { type: "codeVoice", code: "crashRate" },
            ],
          },
        ],
      },
    ],
    references: { x: { type: "text", text: "ignored" } },
  };
  const text = doccToText(json);
  assert.ok(text.includes("Use crashRate") && !text.includes("ignored"));
});

test("parseRows expands ranges, dedupes and sorts", () => {
  assert.deepEqual(parseRows("1-5,12,14"), [1, 2, 3, 4, 5, 12, 14]);
  assert.deepEqual(parseRows("4, 6,16,4"), [4, 6, 16]);
});

test("parseRows rejects junk and descending ranges", () => {
  for (const bad of ["", "a", "5-1", "1-", "-3", "1,,2"])
    assert.throws(() => parseRows(bad), bad);
});

test("changelog guard flags only newer On/As-of entries", () => {
  const text =
    "On September 17, 2026, we notified. As of July 22, 2026 x. starting on October 1, 2026 y.";
  assert.deepEqual(changelogDates(text), ["2026-09-17", "2026-07-22"]);
  assert.deepEqual(newerChangelogEntries(text, "2026-09-17"), []);
  const grown = text + " On October 5, 2026, we changed it.";
  assert.equal(newerChangelogEntries(grown, "2026-09-17").length, 1);
});
