// `--scheme` renders an --html page under each prefers-color-scheme (lintTargets' `scheme`).
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { lintTargets, type PageTarget } from "../src/run.ts";

const page = (body: string) =>
  `data:text/html;base64,${Buffer.from(`<!doctype html><title>t</title><script>${body}</script><body><p>x</p>`).toString("base64")}`;
// The page reports the scheme it saw as a console error, which lintTargets collects per target.
const url = page(
  `console.error(matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")`,
);

// The JS job installs no browser; the ui-kits job (which has Chromium) runs it.
const hasChromium = existsSync(chromium.executablePath());

describe("lintTargets scheme", () => {
  it.skipIf(!hasChromium)("emulates each colour scheme", async () => {
    const browser = await chromium.launch();
    try {
      const targets: PageTarget[] = (["light", "dark"] as const).map((s) => ({
        name: s,
        url,
        scheme: s,
      }));
      const res = await lintTargets(browser, targets);
      expect(res.map((r) => r.consoleErrors)).toEqual([["light"], ["dark"]]);
    } finally {
      await browser.close();
    }
  });
});
