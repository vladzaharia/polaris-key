/**
 * The docs lints (style guide, "What enforces it"): each rule on a small fixture, and the
 * site-wide run against the ledger. The ledger only shrinks: a new hit fails, and so does an
 * entry nothing hits any more.
 */

import { describe, expect, it } from "vitest";
import {
  RULES,
  compare,
  lintPage,
  lintSite,
  loadFacts,
  pathMatcher,
  readLedger,
  tally,
  type Hit,
  type Rule,
} from "../scripts/lint-docs";

const facts = loadFacts();

function lint(
  body: string,
  data: Record<string, unknown> = {},
  id = "build/x",
): Hit[] {
  return lintPage(
    {
      id,
      data: { type: "concept", lastReviewed: "2026-10-09", ...data },
      body,
      firstLine: 1,
    },
    facts,
  );
}
const rules = (hits: Hit[]): Rule[] => hits.map((h) => h.rule);

describe("rules", () => {
  it("passes a clean page", () => {
    expect(lint("Pick an SDK. The SDK caches the license document.\n")).toEqual(
      [],
    );
  });

  it("asks for a type and a review date", () => {
    const hits = lintPage(
      { id: "build/x", data: {}, body: "Text.\n", firstLine: 1 },
      facts,
    );
    expect(rules(hits)).toEqual([
      "frontmatter-type",
      "frontmatter-last-reviewed",
    ]);
  });

  it("flags marketing words and exclamation marks, not inside code", () => {
    expect(rules(lint("It is simply powerful!\n"))).toEqual([
      "banned-word",
      "banned-word",
      "banned-word",
    ]);
    expect(lint("Run `just build`.\n\n```sh\njust build\n```\n")).toEqual([]);
  });

  it("flags time words and future tense", () => {
    expect(rules(lint("It currently works and will change.\n"))).toEqual([
      "time-word",
      "future-tense",
    ]);
    expect(rules(lint("A new device appears.\n"))).toEqual([]);
  });

  it("flags programme ids and plan paths, not SHA-256", () => {
    expect(rules(lint("See LX-33 and plans/P4-01.md and D-14.\n"))).toEqual([
      "programme-id",
      "programme-id",
      "programme-id",
    ]);
    expect(lint("The SHA-256 of the file, UTF-8, X-Forwarded.\n")).toEqual([]);
  });

  it("flags counts of the whole set", () => {
    expect(rules(lint("The six services and the sixth SDK.\n"))).toEqual([
      "count",
      "count",
    ]);
    expect(lint("Every service has a page. Up to 5 codes an hour.\n")).toEqual(
      [],
    );
  });

  it("applies Help's word list only under help/", () => {
    expect(
      rules(lint("Your product and tier.\n", { type: "help" }, "help/x")),
    ).toEqual(["help-word", "help-word"]);
    expect(lint("Your product and tier.\n")).toEqual([]);
  });

  it("checks pkey commands and flags against the CLI's help", () => {
    const body = (cmd: string): string => `\`\`\`sh\n${cmd}\n\`\`\`\n`;
    expect(lint(body("pkey validate --json"))).toEqual([]);
    expect(rules(lint(body("pkey nonesuch")))).toEqual(["pkey-command"]);
    expect(rules(lint(body("pkey validate --bogus-flag")))).toEqual([
      "pkey-command",
    ]);
    expect(rules(lint("Run `pkey nonesuch` first.\n"))).toEqual([
      "pkey-command",
    ]);
    expect(lint("The `.pkey/product` file and pkey_ keys.\n")).toEqual([]);
  });

  it("checks HTTP method and path against the OpenAPI spec", () => {
    const body = (call: string): string => `\`\`\`http\n${call}\n\`\`\`\n`;
    expect(lint(body("POST /license/activate"))).toEqual([]);
    expect(lint(body("GET /:product/.well-known/polaris.json"))).toEqual([]);
    expect(rules(lint(body("POST /license/nonesuch")))).toEqual(["http-path"]);
    expect(rules(lint(body("DELETE /license/activate")))).toEqual([
      "http-path",
    ]);
  });

  it("does not lint stubs, generated pages or templates", () => {
    expect(lint("It is simply powerful!\n", { status: "stub" })).toEqual([]);
    expect(lint("{/* GENERATED PAGE */}\nSimply.\n")).toEqual([]);
    expect(lint("Simply.\n", {}, "build/ui/components/_template")).toEqual([]);
  });

  it("checks each type's skeleton", () => {
    const code = "```sh\nx\n```\n";
    expect(rules(lint(`Intro.\n\n${code}`, { type: "overview" }))).toEqual([
      "type-skeleton",
    ]);
    expect(rules(lint("Intro.\n", { type: "how-to" }))).toEqual([
      "type-skeleton",
    ]);
    expect(lint("Intro.\n\n1. Do it.\n", { type: "how-to" })).toEqual([]);
    expect(rules(lint("## Setup\n", { type: "quickstart" }))).toEqual([
      "type-skeleton",
    ]);
    expect(rules(lint(`Hi.\n\n${code}`, { type: "help" }, "help/x"))).toEqual([
      "type-skeleton",
    ]);
    expect(rules(lint("Rotate it.\n", { type: "runbook" }))).toEqual([
      "type-skeleton",
      "type-skeleton",
    ]);
    expect(
      rules(lint(`${"word ".repeat(260)}\n`, { type: "overview" })),
    ).toEqual(["type-skeleton"]);
  });

  it("every rule is exercised", () => {
    expect(RULES).toHaveLength(11);
  });
});

describe("pathMatcher", () => {
  it("treats {param} as one segment", () => {
    const re = pathMatcher("/{product}/devices/{deviceId}");
    expect(re.test("/acme/devices/abc")).toBe(true);
    expect(re.test("/acme/devices")).toBe(false);
    expect(re.test("/acme/devices/abc/def")).toBe(false);
  });
});

describe("the ledger", () => {
  const actual = tally(lintSite(facts));

  it("holds today's hits and nothing new", () => {
    const { added } = compare(actual, readLedger());
    expect(
      added,
      "a new lint hit: fix the page, or (for a page being rewritten) leave it to its package",
    ).toEqual([]);
  });

  it("holds nothing that no longer hits (the ledger only shrinks)", () => {
    const { stale } = compare(actual, readLedger());
    expect(
      stale,
      "run `pnpm --filter @polaris-key/docs exec tsx scripts/lint-docs.ts --update`",
    ).toEqual([]);
  });

  it("compare reports both directions", () => {
    expect(
      compare({ a: { count: 2 } }, { a: { count: 1 } }).added,
    ).toHaveLength(1);
    expect(
      compare({ a: { count: 1 } }, { a: { count: 2 } }).stale,
    ).toHaveLength(1);
    expect(compare({}, { a: { count: 1 } }).stale).toHaveLength(1);
    expect(compare({ a: { count: 1 } }, { a: { count: 1 } })).toEqual({
      added: [],
      stale: [],
    });
  });
});
