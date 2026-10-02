import { defineConfig } from "vitest/config";

// The browser conformance runner: `corpusV2.browser.test.ts` drives the shared corpus suites
// (`../node/suites.ts`) inside a real browser engine through Vitest browser mode and Playwright.
// One engine per run. Chromium is the default (CI job `browser`); `--browser=firefox` (CI job
// `browser-firefox`, Linux) and `--browser=webkit` (CI job `browser-webkit`, macOS only: Linux
// WebKit crashes on Ed25519 inputs of about 64 KiB or more, see .github/workflows/ci.yml) pick
// the others. Vitest's own `--browser=<name>` flag filters `instances` by name, so the one
// instance declared here must be the one the flag names.
const ENGINES = ["chromium", "firefox", "webkit"] as const;
type Engine = (typeof ENGINES)[number];

function engineFromArgv(argv: readonly string[]): Engine {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let value: string | undefined;
    for (const flag of ["--browser", "--browser.name"]) {
      if (arg.startsWith(`${flag}=`)) value = arg.slice(flag.length + 1);
      else if (arg === flag && argv[i + 1] && !argv[i + 1]!.startsWith("-"))
        value = argv[i + 1];
    }
    if (value === undefined) continue;
    if ((ENGINES as readonly string[]).includes(value)) return value as Engine;
    throw new Error(
      `conformance-browser: unknown engine "${value}" (expected one of ${ENGINES.join(", ")})`,
    );
  }
  return "chromium";
}

export default defineConfig({
  test: {
    include: ["*.test.ts"],
    // The quarter-megabyte cap vectors verify a ~350 KB signing input through WebCrypto; slow
    // engines (Linux Firefox in a container) need more than the 5 s default per case.
    testTimeout: 30_000,
    browser: {
      enabled: true,
      provider: "playwright",
      headless: true,
      // A failing vector is a corpus-level fact, not a rendering one; no screenshot files.
      screenshotFailures: false,
      instances: [{ browser: engineFromArgv(process.argv) }],
    },
  },
});
