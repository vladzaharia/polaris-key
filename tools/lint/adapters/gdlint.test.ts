/** P0-46.7: the gdlint adapter over a fixture of its text output, a parse failure included. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "./gdlint.mjs";

const fixture = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "gdlint.txt"),
  "utf8",
);

describe("gdlint adapter", () => {
  it("maps findings and a parse failure to repo-relative file and rule", () => {
    expect(parse(fixture, { root: "/repo" })).toEqual([
      {
        file: "sdks/godot/addons/polaris_key/core/caps.gd",
        rule: "gdlint:max-line-length",
      },
      {
        file: "sdks/godot/addons/polaris_key/core/caps.gd",
        rule: "gdlint:max-line-length",
      },
      {
        file: "sdks/godot/addons/polaris_key/core/caps.gd",
        rule: "gdlint:load-constant-name",
      },
      {
        file: "sdks/godot/addons/polaris_key/ui/pkey_ui_view.gd",
        rule: "gdlint:parse-error",
      },
      {
        file: "sdks/godot/tests/runner.gd",
        rule: "gdlint:class-definitions-order",
      },
    ]);
  });
  it("takes a clean run", () => {
    expect(parse("Success: no problems found\n", { root: "/repo" })).toEqual(
      [],
    );
  });
  it("throws on foreign input and on a count mismatch", () => {
    expect(() => parse("src/x.py:1: error", { root: "/repo" })).toThrow();
    expect(() => parse("", { root: "/repo" })).toThrow();
    expect(() =>
      parse("Failure: 2 problems found\n", { root: "/repo" }),
    ).toThrow(/2 problems/);
  });
});
