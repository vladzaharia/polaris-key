/**
 * A-32.2 (plans/P4-33-A-32-slices.md D-G5): the example workflow on the CI guide is
 * `renderCiWorkflow`'s output, so the guide, the console panel and the setup PR cannot drift.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACTION_REF_PLACEHOLDER,
  renderCiWorkflow,
} from "../../shared-manifest/src/index";

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(
  join(
    here,
    "..",
    "src",
    "content",
    "docs",
    "features",
    "ship-builds",
    "ci.md",
  ),
  "utf8",
);

describe("ci.md workflow example", () => {
  it("is renderCiWorkflow's output", () => {
    const m =
      /```yaml title="\.github\/workflows\/release\.yml"\n([\s\S]*?)```/.exec(
        page,
      );
    expect(m, "the release.yml fence").not.toBeNull();
    expect(m![1]).toBe(
      renderCiWorkflow({
        product: "my-app",
        channel: "beta",
        actionRef: ACTION_REF_PLACEHOLDER,
        releaseKeys: true,
      }),
    );
  });
});
