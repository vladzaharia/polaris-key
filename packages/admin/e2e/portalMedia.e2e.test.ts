import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/securityHeaders.js";
import {
  MEDIA_CSP,
  MEDIA_IMMUTABLE,
  mediaResponseHeaders,
} from "../../worker/src/services/identity/portal/media.js";

/**
 * PX-W1 (docs/design/PORTAL.md G1): the portal shows developer art only through its same-origin
 * media proxy, because the portal shell's CSP is `img-src 'self' data:` and stays that way.
 *
 * This loads the BUILT portal under the Worker's exact policy and proves both halves in real
 * Chromium: `/media/<product>/<asset>` images, answered with the proxy's own response headers
 * (`mediaResponseHeaders`), load and decode with zero violations; and the same art requested
 * straight from its GitHub host is blocked by the page's policy — so the proxy is load-bearing,
 * not decorative, and the policy did not have to widen.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
// A real 1×1 PNG, so `naturalWidth` proves the browser decoded it.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let server: PreviewServer;
let browser: Browser;
let base: string;
const mediaHits: string[] = [];

beforeAll(async () => {
  if (!existsSync(`${here}dist/index.html`)) {
    throw new Error(
      "Build the console first: pnpm --filter @polaris-key/admin build",
    );
  }
  server = await preview({
    root: here,
    configFile: `${here}vite.config.ts`,
    preview: { port: 0, strictPort: false, host: "127.0.0.1" },
    logLevel: "silent",
  });
  base = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server?.httpServer.close(() => r()));
});

async function open(): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  await ctx.addInitScript(() => {
    (window as unknown as { __v: string[] }).__v = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __v: string[] }).__v.push(
        `${e.violatedDirective} ${e.blockedURI}`,
      ),
    );
  });
  await ctx.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) {
      // Never reached when the CSP blocks it; answered (not fetched) if it ever is.
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        body: PNG,
      });
    }
    if (url.pathname.startsWith("/media/")) {
      mediaHits.push(url.pathname + url.search);
      const headers = Object.fromEntries(
        mediaResponseHeaders({
          "content-type": "image/png",
          "content-length": String(PNG.byteLength),
          "cache-control": MEDIA_IMMUTABLE,
          "content-disposition": "inline",
        }),
      );
      return route.fulfill({ status: 200, headers, body: PNG });
    }
    if (url.pathname.startsWith("/api/")) {
      return route.fulfill({ status: 401, json: { error: "unauthorized" } });
    }
    const res = await route.fetch();
    const headers = { ...res.headers() };
    if (request.resourceType() === "document")
      headers["content-security-policy"] = CSP;
    return route.fulfill({ response: res, headers });
  });
  const page = await ctx.newPage();
  await page.goto(`${base}/`);
  await page.locator("#root *").first().waitFor();
  return page;
}

const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __v: string[] }).__v.splice(0));

/** Add an <img> through the DOM (not inline script) and wait for it to settle. */
const addImage = (page: Page, src: string) =>
  page.evaluate(
    (s) =>
      new Promise<{ ok: boolean; width: number }>((resolve) => {
        const img = document.createElement("img");
        img.alt = "";
        img.onload = () => resolve({ ok: true, width: img.naturalWidth });
        img.onerror = () => resolve({ ok: false, width: 0 });
        img.src = s;
        document.body.appendChild(img);
      }),
    src,
  );

describe("portal art under the Worker's CSP (PX-W1)", () => {
  it("the media proxy's own answer is an image that cannot be a document", () => {
    const h = mediaResponseHeaders({ "content-type": "image/png" });
    expect(h.get("content-security-policy")).toBe(MEDIA_CSP);
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  it("same-origin /media images load with zero violations; the direct host is blocked", async () => {
    const page = await open();
    expect(await violations(page), "portal shell").toEqual([]);

    for (const src of [
      "/media/tidewater/icon?v=3f9a0c2d1e4b5a6c",
      "/media/tidewater/header?v=8b7c6d5e4f3a2b1c",
    ]) {
      const r = await addImage(page, src);
      expect(r, src).toEqual({ ok: true, width: 1 });
    }
    expect(mediaHits).toContain("/media/tidewater/icon?v=3f9a0c2d1e4b5a6c");
    expect(await violations(page), "proxied art").toEqual([]);

    const direct = await addImage(
      page,
      "https://raw.githubusercontent.com/fennick/tidewater/main/icon.png",
    );
    expect(direct.ok).toBe(false);
    const v = await violations(page);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/^img-src https:\/\/raw\.githubusercontent\.com\//);
    await page.context().close();
  });
});
