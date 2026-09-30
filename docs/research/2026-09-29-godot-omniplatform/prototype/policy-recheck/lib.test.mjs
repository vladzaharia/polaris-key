// Offline tests for the extraction and matching helpers: node --test lib.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { doccToText, hasQuote, htmlToText, mdToText, norm } from "./lib.mjs";

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
