/**
 * A-18h: the CLI's copy of the CI plane (`packages/cli/src/storefronts/ciPlane.generated.ts`) is
 * a straight serialise of `src/core/storefront/ciPlane.ts` and the CI-plane adapters, so the CLI
 * runs exactly the allow-list the Worker re-checks on report-back. Stale ⇒ `pnpm
 * gen:storefront-ci`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ciPlaneDeclaration,
  GENERATED_PATH,
  renderCiPlane,
} from "../../scripts/gen-storefront-ci.js";

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

describe("the CLI's generated CI plane (A-18h)", () => {
  it("is up to date (pnpm gen:storefront-ci)", async () => {
    const committed = readFileSync(join(ROOT, GENERATED_PATH), "utf8");
    expect(committed, "run pnpm gen:storefront-ci").toBe(await renderCiPlane());
  });

  it("carries every CI-plane store and only the CI-plane adapters", () => {
    const d = ciPlaneDeclaration();
    expect(d.stores.map((s) => s.store)).toEqual([
      "itch",
      "snap",
      "steam",
      "msstore",
      "epic",
    ]);
    expect(d.adapters.map((a) => a.id)).toEqual(["itch", "snap", "steam"]);
    // A-18g: Steam's only CI op is the depot upload; the rest is the Worker plane or a link.
    expect(d.adapters.find((a) => a.id === "steam")!.ciOps).toEqual({
      uploadBuild: ["run-app-build"],
    });
    expect(d.adapters.find((a) => a.id === "snap")!.ciOps).toEqual({
      writeListingText: ["upload-metadata"],
      uploadBuild: ["upload"],
      release: ["upload"],
    });
  });

  it("carries every PR-plane store (A-18i)", () => {
    const d = ciPlaneDeclaration();
    expect(d.prStores.map((s) => s.store)).toEqual([
      "winget",
      "homebrew",
      "scoop",
      "flathub",
    ]);
    expect(d.prStores.find((s) => s.store === "winget")!.repo).toBe(
      "microsoft/winget-pkgs",
    );
  });
});
