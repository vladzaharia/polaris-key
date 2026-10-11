/**
 * AX-01: every published npm package carries the metadata a registry page and an agent read first,
 * and no published README links the docs site by a root-relative path (on a registry or in
 * `node_modules` a `/docs/…` link resolves against the wrong origin). A package is published when
 * its `package.json` is not `private`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "packages", "docs", "src", "content", "docs");
const REPO_URL = "git+https://github.com/vladzaharia/polaris-key.git";
const ISSUES_URL = "https://github.com/vladzaharia/polaris-key/issues";

interface Manifest {
  name: string;
  private?: boolean;
  description?: unknown;
  keywords?: unknown;
  repository?: { type?: unknown; url?: unknown; directory?: unknown };
  homepage?: unknown;
  bugs?: { url?: unknown };
}

const published = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((dir) => existsSync(join(ROOT, "packages", dir, "package.json")))
  .map((dir) => ({
    dir: `packages/${dir}`,
    pkg: JSON.parse(
      readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8"),
    ) as Manifest,
  }))
  .filter(({ pkg }) => pkg.private !== true);

/** A docs URL names a page when a content file or an index file answers it. */
function docsPageExists(url: URL): boolean {
  const path = url.pathname.replace(/^\/docs\//, "").replace(/\/$/, "");
  return ["", "/index"].some((tail) =>
    [".md", ".mdx"].some((ext) => existsSync(join(DOCS, path + tail + ext))),
  );
}

describe("published packages", () => {
  it("finds the published packages", () => {
    // A change of layout would otherwise leave nothing to check.
    const names = published.map(({ pkg }) => pkg.name);
    expect(names).toEqual(
      expect.arrayContaining(["@polaris-key/node", "@polaris-key/cli"]),
    );
  });

  for (const { dir, pkg } of published)
    describe(`${pkg.name} (${dir})`, () => {
      it("has a description", () => {
        expect(typeof pkg.description).toBe("string");
        expect((pkg.description as string).trim().length).toBeGreaterThan(20);
      });

      it("has keywords", () => {
        expect(Array.isArray(pkg.keywords)).toBe(true);
        const keywords = pkg.keywords as unknown[];
        expect(keywords.length).toBeGreaterThan(0);
        expect(keywords.every((k) => typeof k === "string" && k !== "")).toBe(
          true,
        );
        expect(new Set(keywords).size).toBe(keywords.length);
      });

      it("names the repository and its own directory", () => {
        expect(pkg.repository).toEqual({
          type: "git",
          url: REPO_URL,
          directory: dir,
        });
      });

      it("has a homepage that resolves", () => {
        expect(typeof pkg.homepage).toBe("string");
        const url = new URL(pkg.homepage as string);
        expect(url.protocol).toBe("https:");
        if (url.hostname === "key.plrs.im")
          expect(docsPageExists(url), `${url.href} names no docs page`).toBe(
            true,
          );
      });

      it("has a bugs url", () => {
        expect(pkg.bugs).toEqual({ url: ISSUES_URL });
      });

      it("has no root-relative /docs/ link in its README", () => {
        const readme = join(ROOT, dir, "README.md");
        if (!existsSync(readme)) return;
        const hits = readFileSync(readme, "utf8")
          .split("\n")
          .map((text, i) => ({ line: i + 1, text }))
          .filter(({ text }) =>
            /\]\(\s*\/docs\/|href="\/docs\/|\]:\s*\/docs\//.test(text),
          )
          .map(({ line, text }) => `${dir}/README.md:${line}: ${text.trim()}`);
        expect(hits).toEqual([]);
      });
    });
});
