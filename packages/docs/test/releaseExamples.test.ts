/**
 * The `.pkey/release` examples on the Ship builds pages (DOC-10a): each yaml fence whose top-level
 * keys are release-document keys is merged into a minimal release document and must pass the
 * manifest validator, the one `pkey validate` and ingest run.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  parseManifest,
  validateManifestDocuments,
} from "../../shared-manifest/src/index";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(
  here,
  "..",
  "src",
  "content",
  "docs",
  "features",
  "ship-builds",
);
const PAGES = [
  "ci.md",
  ...readdirSync(join(root, "releases")).map((f) => `releases/${f}`),
];
const RELEASE_KEYS = new Set(["release", "publishing", "deliverables"]);

const BASE_RELEASE = {
  release: {
    provider: { type: "github", owner: "acme", repo: "desktop" },
    binaryName: "acme",
  },
};
const PRODUCT = {
  product: { slug: "acme", name: "Acme" },
  modules: { release: { enabled: true } },
};

function fences(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(
    /^([ \t]*)```yaml(?: [^\n]*)?\n([\s\S]*?)\n\1```/gm,
  )) {
    const indent = m[1]!;
    out.push(
      m[2]!
        .split("\n")
        .map((l) => l.slice(indent.length))
        .join("\n"),
    );
  }
  return out;
}

const examples = PAGES.flatMap((page) =>
  fences(readFileSync(join(root, page), "utf8")).flatMap((src) => {
    let doc: unknown;
    try {
      doc = yaml.load(src);
    } catch {
      return [];
    }
    if (typeof doc !== "object" || doc === null || Array.isArray(doc))
      return [];
    const keys = Object.keys(doc);
    return keys.length > 0 && keys.every((k) => RELEASE_KEYS.has(k))
      ? [{ page, doc: doc as Record<string, unknown> }]
      : [];
  }),
);

describe("release examples", () => {
  it("finds the trusted-publisher example", () => {
    expect(examples.some((e) => "publishing" in e.doc)).toBe(true);
  });

  for (const { page, doc } of examples) {
    it(`${page}: ${Object.keys(doc).join(", ")} passes the validator`, () => {
      const release = {
        ...BASE_RELEASE,
        ...doc,
        release: {
          ...BASE_RELEASE.release,
          ...((doc.release as object) ?? {}),
        },
      };
      const parsed = parseManifest({
        product: JSON.stringify(PRODUCT),
        schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
        release: JSON.stringify(release),
      });
      expect(parsed.ok ? [] : parsed.errors).toEqual([]);
      if (parsed.ok) {
        const res = validateManifestDocuments({
          product: PRODUCT,
          schema: { schemaVersion: 1, entries: [] },
          release,
        });
        expect(res.errors).toEqual([]);
      }
    });
  }
});
