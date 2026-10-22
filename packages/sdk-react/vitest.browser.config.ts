import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/** The slice of Playwright's `Page` the commands use. */
interface PlaywrightPage {
  locator(selector: string): {
    screenshot(options: { path: string }): Promise<unknown>;
  };
  emulateMedia(options: {
    colorScheme?: "dark" | "light" | null;
    forcedColors?: "active" | "none" | null;
    contrast?: "more" | "no-preference" | null;
    reducedMotion?: "reduce" | "no-preference" | null;
  }): Promise<void>;
}

// The drop-in kit in real Chromium (test/browser/*.browser.test.tsx): responsive scenes run at
// every §7.1 row; every non-hidden ui-matrix state also runs at the committed 390 and 1440 rows,
// in dark and light. `pnpm --filter @polaris-key/react test:browser` needs Chromium
// (`pnpm --filter @polaris-key/react exec playwright install chromium`). The jsdom suite
// (vitest.config.ts) leaves test/browser/ out.
//
// PKEY_KIT_SHOTS=<dir> writes every responsive render to
// <dir>/react.<scene>/<size>-<scheme>.png. PKEY_KIT_BASELINES=<dir> writes the complete
// 390/1440 dark/light fixture matrix directly under <dir>/<Component>.<state>/.
export default defineConfig({
  define: {
    __PKEY_KIT_SHOTS__: JSON.stringify(process.env.PKEY_KIT_SHOTS ?? ""),
    __PKEY_KIT_BASELINES__: JSON.stringify(
      process.env.PKEY_KIT_BASELINES ?? "",
    ),
  },
  test: {
    include: ["test/browser/**/*.browser.test.tsx"],
    testTimeout: 60_000,
    // One file, many renders: report each test, keep the run in one browser page.
    fileParallelism: false,
    browser: {
      enabled: true,
      provider: playwright({
        // Larger than the largest viewport under test, so the test frame is never scaled down.
        contextOptions: { viewport: { width: 2600, height: 1500 } },
      }),
      headless: true,
      screenshotFailures: false,
      instances: [{ browser: "chromium" }],
      commands: {
        // A screenshot of the test frame at its own size, written wherever PKEY_KIT_SHOTS points
        // (outside the project, which Vitest's own screenshot refuses).
        async kitShot(ctx, file: string) {
          const page = (ctx as unknown as { page: PlaywrightPage }).page;
          await mkdir(dirname(file), { recursive: true });
          await page
            .locator('iframe[data-vitest="true"]')
            .screenshot({ path: file });
        },
        // The OS colour scheme (`prefers-color-scheme`), for colorScheme "system"; null resets.
        // Forced colours (`forced-colors: active`), the OS high-contrast mode; null resets.
        async emulateForced(ctx, forced: "active" | null) {
          const page = (ctx as unknown as { page: PlaywrightPage }).page;
          await page.emulateMedia({ forcedColors: forced });
        },
        // Increase Contrast (`prefers-contrast: more`); null resets.
        async emulateContrast(ctx, contrast: "more" | null) {
          const page = (ctx as unknown as { page: PlaywrightPage }).page;
          await page.emulateMedia({ contrast });
        },
        // Reduced motion (`prefers-reduced-motion: reduce`); null resets.
        async emulateMotion(ctx, motion: "reduce" | null) {
          const page = (ctx as unknown as { page: PlaywrightPage }).page;
          await page.emulateMedia({ reducedMotion: motion });
        },
        async emulateScheme(ctx, scheme: "dark" | "light" | null) {
          const page = (ctx as unknown as { page: PlaywrightPage }).page;
          await page.emulateMedia({ colorScheme: scheme });
        },
      },
    },
  },
});
