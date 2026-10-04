import { describe, expect, it } from "vitest";
import { tokenizeLine, tokenize } from "../../src/lib/highlight.js";

const kinds = (line: string, lang: Parameters<typeof tokenizeLine>[1]) =>
  tokenizeLine(line, lang)
    .filter((t) => t.text.trim() !== "")
    .map((t) => [t.kind, t.text.trim()]);

describe("highlight tokenizer", () => {
  it("json: keys, strings, numbers, literals", () => {
    expect(kinds(`"a": "b", "n": 12, "t": true`, "json")).toEqual([
      ["key", '"a"'],
      ["punctuation", ":"],
      ["string", '"b"'],
      ["punctuation", ","],
      ["key", '"n"'],
      ["punctuation", ":"],
      ["number", "12"],
      ["punctuation", ","],
      ["key", '"t"'],
      ["punctuation", ":"],
      ["keyword", "true"],
    ]);
  });
  it("ts: keywords, strings and a trailing comment", () => {
    const t = kinds(`const x = await f("y"); // note`, "ts");
    expect(t[0]).toEqual(["keyword", "const"]);
    expect(t).toContainEqual(["keyword", "await"]);
    expect(t).toContainEqual(["string", '"y"']);
    expect(t[t.length - 1]).toEqual(["comment", "// note"]);
  });
  it("sh: variables and comments", () => {
    const t = kinds(`export A=$CI_TOKEN # secret`, "sh");
    expect(t).toContainEqual(["keyword", "$CI_TOKEN"]);
    expect(t[t.length - 1]).toEqual(["comment", "# secret"]);
  });
  it("toml: table headers and keys", () => {
    expect(kinds("[services.license]", "toml")).toEqual([
      ["key", "[services.license]"],
    ]);
    expect(kinds('slug = "djdl"', "toml").slice(0, 2)).toEqual([
      ["key", "slug"],
      ["punctuation", "="],
    ]);
  });
  it("yaml: keys at line start, list items", () => {
    expect(kinds("  - id: stable", "yaml")[0]).toEqual(["plain", "-"]);
    expect(kinds("  - id: stable", "yaml")).toContainEqual(["key", "id"]);
    expect(kinds("critical: false", "yaml")).toContainEqual([
      "keyword",
      "false",
    ]);
  });
  it("text is plain, and tokenize splits lines", () => {
    expect(tokenizeLine("const x", "text")).toEqual([
      { kind: "plain", text: "const x" },
    ]);
    expect(tokenize("a\nb\n", "text")).toHaveLength(2);
  });
});
