/**
 * The developer changelog's entries (DOC-12a.1): the committed ones load, and a bad entry is
 * refused by the generator with the file named.
 */

import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadChangelog, upgradeRows } from "../scripts/gen-reference.mjs";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "changelog");
type Entry = { version: string; file: string; replaces?: unknown[] };
const load = loadChangelog as (dir?: string) => Entry[];

const entry = (front: string, body = "Note.") =>
  `---\ntitle: "T"\ndate: "2026-10-24"\nversion: "0.9.1"\ntype: "fix"\nservices: []\nsdks: []\n${front}---\n\n${body}\n`;

function withEntry(text: string, name = "2026-10-24-bad.md") {
  const tmp = mkdtempSync(join(tmpdir(), "changelog-"));
  cpSync(join(dir, "schema.json"), join(tmp, "schema.json"));
  writeFileSync(join(tmp, name), text);
  return tmp;
}

describe("changelog entries", () => {
  it("load, newest version first", () => {
    const versions = load().map((e) => e.version);
    // Newest first: by major, minor, then patch, where `x` (no patch named) is the newest patch.
    const key = (v: string) =>
      v.split(".").map((p) => (p === "x" ? Infinity : Number(p)));
    const newestFirst = (a: string, b: string) => {
      const [ka, kb] = [key(a), key(b)];
      for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return kb[i]! - ka[i]!;
      return 0;
    };
    expect(versions).toEqual([...versions].sort(newestFirst));
    expect(versions.at(-1)).toBe("0.9.0");
  });

  it("refuse an unknown type", () => {
    const text = entry("").replace('type: "fix"', 'type: "tweak"');
    expect(() => load(withEntry(text))).toThrow(/2026-10-24-bad\.md.*type/);
  });

  it("refuse an unknown surface and a missing new", () => {
    const rows = 'replaces:\n  - old: "a"\n    surface: "web"\n';
    expect(() => load(withEntry(entry(rows)))).toThrow(
      /missing new.*not one of/,
    );
  });

  it("refuse a body over 150 words", () => {
    const long = Array(151).fill("word").join(" ");
    expect(() => load(withEntry(entry("", long)))).toThrow(/151 words/);
  });

  it("refuse an unknown service and a file name without its date", () => {
    expect(() =>
      load(withEntry(entry("").replace("services: []", 'services: ["nope"]'))),
    ).toThrow(/unknown service/);
    expect(() => load(withEntry(entry(""), "2026-01-01-x.md"))).toThrow(
      /start with the entry's date/,
    );
  });
});

describe("upgrade rows", () => {
  it("the SDK table takes the removed names of api.json", () => {
    expect(
      (upgradeRows as (s: string, e: Entry[]) => unknown[])("sdk", load())
        .length,
    ).toBeGreaterThan(60);
  });
});
