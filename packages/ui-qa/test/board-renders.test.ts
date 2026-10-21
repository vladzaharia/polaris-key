// UK-59: a "Built today" frame names a committed render, so the path has to exist. The browser lint
// checks that a frame embeds a render path; this checks that every such path is a real file, in
// both themes, so a re-record that renames a baseline fails here instead of leaving a broken image.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.ts";

const BOARDS = resolve(REPO_ROOT, "docs/design/ui-kits");
const RENDERS: Record<string, (name: string, theme: string) => string> = {
  react: (n, t) =>
    `packages/sdk-react/test/visual/__screenshots__/${n}-${t}.png`,
  swift: (n, t) =>
    `sdks/swift/Tests/PolarisKeyUISnapshotTests/__Snapshots__/${n}-${t}.png`,
  "swift-ax3": (n) =>
    `sdks/swift/Tests/PolarisKeyUISnapshotTests/__Snapshots__/${n}/iphone-440x956-portrait-AX3-polaris-key-dark.png`,
  node: (n, t) => `packages/sdk-node/test/cli/golden/${n}-${t}.png`,
};

describe("board renders", () => {
  for (const file of readdirSync(BOARDS).filter((f) => f.endsWith(".html"))) {
    const html = readFileSync(resolve(BOARDS, file), "utf8");
    const paths = new Set<string>();
    for (const m of html.matchAll(/<img[^>]*\ssrc="([^"$]+)"/g))
      if (m[1]!.startsWith("../")) paths.add(resolve(BOARDS, m[1]!));
    for (const m of html.matchAll(/data-render="([a-z0-9-]+):([^"]+)"/g))
      for (const theme of ["dark", "light"]) {
        // The AX3 baseline is committed in dark only, and used in both themes.
        const rel = RENDERS[m[1]!]!(m[2]!, theme);
        paths.add(resolve(REPO_ROOT, rel));
      }
    for (const m of html.matchAll(/data-built-from="([^"]+)"/g))
      for (const p of m[1]!.split(/\s+/)) paths.add(resolve(REPO_ROOT, p));
    if (!paths.size) continue;
    it(`${file}: every committed render it names exists`, () => {
      const missing = [...paths].filter((p) => !existsSync(p));
      expect(missing).toEqual([]);
    });
  }

  it("names no render the resolver does not know", () => {
    for (const file of readdirSync(BOARDS).filter((f) => f.endsWith(".html")))
      for (const m of readFileSync(resolve(BOARDS, file), "utf8").matchAll(
        /data-render="([a-z0-9-]+):/g,
      ))
        expect(Object.keys(RENDERS)).toContain(m[1]);
  });
});
