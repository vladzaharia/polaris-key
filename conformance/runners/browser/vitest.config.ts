import { playwright } from "@vitest/browser-playwright";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** The slice of Playwright's `Page` the command below uses. */
interface PlaywrightPage {
  context(): {
    browser(): { browserType(): { name(): string } } | null;
    addCookies(
      cookies: { name: string; value: string; url: string }[],
    ): Promise<void>;
    newCDPSession(page: PlaywrightPage): Promise<{
      send(method: string, params?: Record<string, unknown>): Promise<unknown>;
      detach(): Promise<void>;
    }>;
  };
}

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

// `dcz.setup.ts` imports the Worker's pure `core/cors.ts` so the harness answers with production
// CORS. That file imports `@polaris-key/manifest` and `@polaris-key/protocol`, which Node would
// look up beside the Worker; CI installs only this runner's graph (`pnpm install
// --filter=...conformance-browser...`), so `packages/worker/node_modules` does not exist there.
// Resolve both from this package's own dependencies instead.
const OWN_DEPS = ["@polaris-key/manifest", "@polaris-key/protocol"] as const;

export default defineConfig({
  resolve: {
    alias: OWN_DEPS.map((name) => ({
      find: new RegExp(`^${name.replace("/", "\\/")}$`),
      replacement: fileURLToPath(import.meta.resolve(name)),
    })),
  },
  test: {
    include: ["*.test.ts"],
    // P4-18: the payload-URL server `dcz.browser.test.ts` fetches from (cross-origin, Node side).
    globalSetup: ["./dcz.setup.ts"],
    // The quarter-megabyte cap vectors verify a ~350 KB signing input through WebCrypto; slow
    // engines (Linux Firefox in a container) need more than the 5 s default per case.
    testTimeout: 30_000,
    browser: {
      enabled: true,
      // Vitest 4 takes the provider as a factory from its own package.
      provider: playwright(),
      headless: true,
      // A failing vector is a corpus-level fact, not a rendering one; no screenshot files.
      screenshotFailures: false,
      instances: [{ browser: engineFromArgv(process.argv) }],
      commands: {
        // P4-18 review (`dcz.browser.test.ts`): a cookie for the payload server's origin, so any
        // pack fetch that carried ambient credentials would show (the server refuses it).
        async seedCookie(ctx, url: string) {
          const page = (ctx as unknown as { page: PlaywrightPage }).page;
          await page
            .context()
            .addCookies([{ name: "pkey_ambient", value: "1", url }]);
        },
        // P4-18 (`dcz.browser.test.ts`): drop the browser's Compression Dictionary Transport
        // dictionaries, as cache eviction would. Chromium alone keeps any (over CDP); elsewhere
        // there is nothing to drop.
        async clearDictionaries(ctx) {
          const page = (ctx as unknown as { page: PlaywrightPage }).page;
          if (page.context().browser()?.browserType().name() !== "chromium")
            return false;
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Network.clearBrowserCache");
          await cdp.detach();
          return true;
        },
      },
    },
  },
});
