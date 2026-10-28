import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/** The slice of Playwright's `Page` the commands use. */
interface PlaywrightPage {
  context(): {
    newCDPSession(page: PlaywrightPage): Promise<{
      send(method: string, params?: object): Promise<unknown>;
    }>;
  };
  locator(selector: string): {
    screenshot(options: { path: string }): Promise<unknown>;
  };
  emulateMedia(options: {
    colorScheme?: "dark" | "light" | null;
    forcedColors?: "active" | "none" | null;
    reducedMotion?: "reduce" | "no-preference" | null;
  }): Promise<void>;
}

// The elements in real Chromium (test/browser/*.browser.test.ts): every component state of
// ui-matrix.json at the phone and desktop rows in dark and light, with axe on every render, the
// keyboard path and forced colours. `pnpm --filter @polaris-key/elements test:browser`; it needs
// Chromium (`pnpm --filter @polaris-key/elements exec playwright install chromium`). The jsdom
// suite (vitest.config.ts) leaves test/browser/ out.
//
// PKEY_KIT_BASELINES=<dir> writes the 390/1440 dark/light fixture matrix to <dir>/<Component>.<state>/
// (test/browser/visual.browser.test.ts; `pnpm test:visual` points it at test/visual/__screenshots__).
// PKEY_KIT_SHOTS=<dir> writes every render to <dir>/elements.<component>.<state>/<size>-<scheme>.png.
export default defineConfig({
  define: {
    __PKEY_KIT_SHOTS__: JSON.stringify(process.env.PKEY_KIT_SHOTS ?? ""),
    __PKEY_KIT_BASELINES__: JSON.stringify(
      process.env.PKEY_KIT_BASELINES ?? "",
    ),
    __PKEY_FONTS__: JSON.stringify(
      `/@fs${fileURLToPath(new URL("../brand/fonts/", import.meta.url))}`,
    ),
  },
  test: {
    include: ["test/browser/**/*.browser.test.ts"],
    setupFiles: ["test/setupCopy.ts"],
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
        // A coarse pointer (`pointer: coarse`): touch emulation through the DevTools protocol.
        async emulateTouch(ctx, on: boolean) {
          const page = (ctx as unknown as { page: PlaywrightPage }).page;
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Emulation.setTouchEmulationEnabled", {
            enabled: on,
            maxTouchPoints: on ? 5 : 1,
          });
        },
        async emulateForced(ctx, forced: "active" | null) {
          const page = (ctx as unknown as { page: PlaywrightPage }).page;
          await page.emulateMedia({ forcedColors: forced });
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
