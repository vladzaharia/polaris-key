// The runtime floor of the code that ships in `@polaris-key/react`'s browser bundle (P1b-04
// plan §2.4, "Runtimes"). That bundle runs in Safari and every iOS browser, Chromium, Firefox
// and the system webviews of Tauri apps (WKWebView, WebKitGTK), whose WebKit is the operating
// system's and can be years behind the current Safari. No floor is documented, so the source of
// the packages in that bundle uses nothing newer than they ship today:
//
//   - a regular-expression lookbehind is an early SyntaxError before Safari 16.4, so the WHOLE
//     bundle (the app's own code included) would fail to parse;
//   - `String.prototype.isWellFormed` / `toWellFormed` arrive in Safari 16.4;
//   - `Object.hasOwn` arrives in Safari 15.4.
//
// This scans tokens and does not parse code: it catches the constructs it names, not every
// newer feature.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every package whose `src/` reaches the React bundle. */
const PACKAGES = [
  "packages/client-core",
  "packages/shared-protocol",
  "packages/shared-jws",
  "packages/sdk-react",
  // The SDK's UI renders the brand's marks and tokens (`@polaris-key/brand`).
  "packages/brand",
];

/** Built from parts so that this file never reads as using them. */
const FORBIDDEN = [
  "(?" + "<=",
  "(?" + "<!",
  "isWell" + "Formed(",
  "toWell" + "Formed(",
  "Object." + "hasOwn(",
];

export function floorViolations(source: string): string[] {
  return FORBIDDEN.filter((token) => source.includes(token));
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(path);
  }
  return out;
}

describe("runtime floor of the React bundle's sources", () => {
  const files = PACKAGES.flatMap((pkg) => sourceFiles(join(ROOT, pkg, "src")));

  it("finds the sources it guards", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(
      files.some((f) => f.endsWith("packages/client-core/src/config.ts")),
    ).toBe(true);
  });

  it("no source uses a lookbehind, isWellFormed, toWellFormed or Object.hasOwn", () => {
    const hits: string[] = [];
    for (const file of files) {
      for (const token of floorViolations(readFileSync(file, "utf8")))
        hits.push(`${relative(ROOT, file)}: ${token}`);
    }
    expect(hits).toEqual([]);
  });

  it("flags a doctored source (the scan is not inert)", () => {
    const doctored = [
      "const re = /(?<=a)b/;",
      'const ok = "x".isWellFormed();',
      "if (Object.hasOwn(o, k)) {}",
    ].join("\n");
    expect(floorViolations(doctored)).toEqual([
      FORBIDDEN[0],
      FORBIDDEN[2],
      FORBIDDEN[4],
    ]);
    expect(floorViolations("const re = /(?<!a)b/;")).toEqual([FORBIDDEN[1]]);
    expect(floorViolations("s.toWellFormed()")).toEqual([FORBIDDEN[3]]);
  });
});
