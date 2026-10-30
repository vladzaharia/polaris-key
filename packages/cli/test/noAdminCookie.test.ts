// Nothing reads the retired console-cookie variable (ST-34.9, D-5). Its name may appear only in
// the file that refuses it and that file's test (and the Action bundle that compiles it in), in the 0.9 upgrade page, in the removal's changelog entry, in the design mockups
// and research notes (history), and in migration 0119's comment. A tracked file anywhere else that
// names it, including the committed Action bundle, fails here.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
// Built from parts so this file does not name the variable itself.
const NAME = ["PKEY", "ADMIN", "COOKIE"].join("_");

const ALLOWED: (string | RegExp)[] = [
  "packages/cli/src/retired.ts",
  "packages/cli/test/retired.test.ts",
  // The committed Action bundle compiles retired.ts in; the next test holds it to that one line.
  "actions/publish/dist/index.js",
  "packages/docs/src/content/docs/build/upgrade-to-0-9.md",
  // The removal's changelog entry and the generated changelog index that lists it.
  "packages/docs/changelog/2026-10-28-pkey-admin-cookie-removed.md",
  "packages/docs/src/content/docs/reference/changelog/index.mdx",
  "packages/worker/migrations/0119_admin_api_tokens.sql",
  /^docs\/design\/mockups\//,
  /^docs\/research\//,
];

const allowed = (file: string) =>
  ALLOWED.some((a) => (typeof a === "string" ? a === file : a.test(file)));

describe("no reader of the retired cookie variable", () => {
  it("names it only where the allowlist says", () => {
    // `git grep` reads the index and untracked files alike, and is quick enough for a unit test.
    let listed = "";
    try {
      listed = execFileSync(
        "git",
        ["grep", "-l", "-I", "-F", "--untracked", "-z", "-e", NAME],
        { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
      ).toString("utf8");
    } catch (e) {
      // Exit 1 is "no match".
      if ((e as { status?: number }).status !== 1) throw e;
    }
    const hits = listed
      .split("\0")
      .filter(Boolean)
      .filter((file) => !allowed(file));
    expect(hits).toEqual([]);
  });

  it("the Action bundle holds the name once, as retired.ts's declaration", () => {
    const bundle = readFileSync(
      path.join(ROOT, "actions/publish/dist/index.js"),
      "utf8",
    );
    expect(bundle.split(NAME)).toHaveLength(2);
    expect(bundle).toContain(`var RETIRED_COOKIE_ENV = "${NAME}";`);
  });

  it("the allowlisted source file is the refusal and nothing else", () => {
    const src = readFileSync(
      path.join(ROOT, "packages/cli/src/retired.ts"),
      "utf8",
    );
    // One declaration; every other mention is the doc comment.
    expect(src.match(/const RETIRED_COOKIE_ENV = /g)).toHaveLength(1);
  });
});
