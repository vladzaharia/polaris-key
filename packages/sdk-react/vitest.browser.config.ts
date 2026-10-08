import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/** The slice of Playwright's `Page` the screenshot command uses. */
interface PlaywrightPage {
  locator(selector: string): {
    screenshot(options: { path: string }): Promise<unknown>;
  };
}

// The drop-in kit in real Chromium (test/browser/responsive.browser.test.tsx): every screen at
// phone, tablet, desktop and monitor widths, a phone on its side, 200 % zoom and a 24 px root
// font, in dark and light. `pnpm --filter @polaris-key/react test:browser`; it needs Chromium
// (`pnpm --filter @polaris-key/react exec playwright install chromium`). The jsdom suite
// (vitest.config.ts) leaves test/browser/ out.
//
// PKEY_KIT_SHOTS=<dir> writes every render to <dir>/react.<scene>/<size>-<scheme>.png.
export default defineConfig({
  define: {
    __PKEY_KIT_SHOTS__: JSON.stringify(process.env.PKEY_KIT_SHOTS ?? ""),
  },
  test: {
    include: ["test/browser/**/*.browser.test.tsx"],
    testTimeout: 60_000,
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
      },
    },
  },
});
