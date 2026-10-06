// The Playwright half of the modernity lint: open a page (a mockup board, a kit's component
// test page, any URL), inject src/browser/lint.js and collect what it finds. Kits call lintPage()
// from their own component tests; `pnpm ui:lint` calls lintTargets() over the mockup boards and
// any kit CSS it is given.
import { readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright";
import type { LintOptions, LintResult, Violation } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const LINT_SCRIPT = readFileSync(
  resolve(here, "browser/lint.js"),
  "utf8",
);

/** Records alert/confirm/prompt calls; installed before any page script runs. */
const ALERT_TRAP = `(() => {
  window.__pkUiLintAlerts = [];
  for (const k of ["alert", "confirm", "prompt"]) {
    window[k] = () => { window.__pkUiLintAlerts.push(k); return k === "confirm" ? false : null; };
  }
})();`;

/** Install the alert trap on a page before it navigates (kits' component tests call this). */
export async function prepare(page: Page): Promise<void> {
  await page.addInitScript(ALERT_TRAP);
}

/** Lint whatever the page shows now. */
export async function lintPage(
  page: Page,
  options: LintOptions = {},
): Promise<LintResult> {
  await page.evaluate(() => document.fonts.ready);
  const loaded = await page.evaluate(
    () => typeof (window as unknown as { __pkUiLint?: unknown }).__pkUiLint,
  );
  if (loaded !== "function") await page.addScriptTag({ content: LINT_SCRIPT });
  return page.evaluate(
    (o) =>
      (
        window as unknown as {
          __pkUiLint: (o: unknown) => LintResult;
        }
      ).__pkUiLint(o),
    options,
  );
}

export interface PageTarget {
  /** A label for the report: the board name, or the file's path. */
  name: string;
  url: string;
  theme?: "dark" | "light";
  options?: LintOptions;
  viewport?: { width: number; height: number };
}

export interface TargetResult extends LintResult {
  target: PageTarget;
  consoleErrors: string[];
}

export async function lintTargets(
  browser: Browser,
  targets: PageTarget[],
): Promise<TargetResult[]> {
  const out: TargetResult[] = [];
  for (const target of targets) {
    const page = await browser.newPage({
      viewport: target.viewport ?? { width: 3200, height: 2000 },
    });
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(e.message));
    await prepare(page);
    await page.goto(target.url);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    const res = await lintPage(page, target.options);
    out.push({ ...res, target, consoleErrors });
    await page.close();
  }
  return out;
}

/** A page that holds nothing but the given CSS, for linting kit stylesheets on their own. */
export function cssPageUrl(file: string): string {
  const css = readFileSync(file, "utf8");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style data-file="${file}">${css}</style></head><body data-ui-scope="${file}"><div></div></body></html>`;
  return `data:text/html;base64,${Buffer.from(html).toString("base64")}`;
}

export function fileUrl(file: string, query = ""): string {
  return pathToFileURL(file).href + query;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

/**
 * Serve a directory over loopback HTTP. Pages are linted over HTTP, not file://, because Chromium
 * treats every file:// stylesheet as cross-origin and hides its rules from the CSSOM, which would
 * silently exempt every linked kit stylesheet from the authored-CSS rules.
 */
export async function serveDir(
  root: string,
): Promise<{ base: string; close: () => Promise<void> }> {
  const top = resolve(root);
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent(
      new URL(req.url ?? "/", "http://x").pathname,
    );
    const file = normalize(resolve(top, "." + path));
    if (file !== top && !file.startsWith(top + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (!statSync(file).isFile()) throw new Error("not a file");
      res.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

export type { Violation };
