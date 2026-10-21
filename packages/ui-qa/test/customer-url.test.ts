// A customer is sent to polaris.locker/device or polaris.locker/tv, never to the console host's
// copy of the same page. Scans kit source and the kit copy catalogue; the Worker, developer docs
// and tests are exempt.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.ts";

const ROOTS = [
  "packages/client-core/src",
  "packages/ui-core/src",
  "packages/elements/src",
  "packages/sdk-react/src",
  "packages/sdk-node/src",
  "packages/brand/kit-copy",
  "sdks/python/src/polaris_key/ui",
  "sdks/python/src/polaris_key/constants_generated.py",
  "sdks/swift/Sources/PolarisKeyUI",
  "sdks/swift/Sources/PolarisKeyUICore",
  "sdks/swift/Sources/PolarisKeyCore/Constants.generated.swift",
  "sdks/kotlin/ui/src/androidMain",
  "sdks/kotlin/ui/src/commonMain",
  "sdks/kotlin/ui-core/src/main",
  "sdks/kotlin/core/src/main/kotlin/im/plrs/key/core/Constants.generated.kt",
  "sdks/godot/addons/polaris_key/ui",
  "sdks/godot/addons/polaris_key/core/constants_generated.gd",
];
const SKIP = new Set(["node_modules", "build", "dist", ".gradle"]);
const BAD = /key\.plrs\.im\/(device|tv|activate)\b/;

function files(path: string): string[] {
  const s = statSync(path, { throwIfNoEntry: false });
  if (!s) return [];
  if (s.isFile()) return [path];
  return readdirSync(path).flatMap((n) =>
    SKIP.has(n) ? [] : files(join(path, n)),
  );
}

describe("customer-facing device URL", () => {
  it("never names key.plrs.im/device, /tv or /activate in kit source or copy", () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(join(REPO_ROOT, root))) {
        if (/\.(png|ttf|woff2?|jar)$/.test(f)) continue;
        readFileSync(f, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (BAD.test(line)) hits.push(`${relative(REPO_ROOT, f)}:${i + 1}`);
          });
      }
    }
    expect(
      hits,
      "use polaris.locker/device, /tv or /activate (DEVICE_CODE_PAGE, CUSTOMER_ORIGIN_DEFAULT)",
    ).toEqual([]);
  });
  it("scans something", () => {
    expect(
      files(join(REPO_ROOT, "packages/ui-core/src")).length,
    ).toBeGreaterThan(5);
  });
});
