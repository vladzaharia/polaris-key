import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/platform/securityHeaders.js";
import {
  AVATAR_CSP,
  renditionKey,
  serveAvatar,
} from "../../worker/src/services/identity/card/avatars.js";
import type { Env } from "../../worker/src/platform/env.js";

/**
 * PX-W16 (docs/design/PORTAL.md §4.30 rule 3, G33): account pictures are copied, re-encoded and
 * served same-origin, so the portal shell's CSP stays `img-src 'self' data:`.
 *
 * This loads the BUILT portal under the Worker's exact policy and answers every
 * `/media/avatar/…` request with the Worker's own `serveAvatar` over an in-memory bucket holding
 * real WebP and PNG renditions. It proves in real Chromium that the pictures load and decode with
 * zero violations (the negotiated 256 px one, which Chromium asks for as WebP, and the named 96 px
 * PNG), and that the same picture requested straight from the provider's host is blocked by the
 * page's policy: the copy is load-bearing, and the policy did not have to widen.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
// Real 1×1 images, so `naturalWidth` proves the browser decoded them.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const WEBP = Buffer.from(
  "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==",
  "base64",
);
const ASSET = "3f9a0c2d1e4b5a6c".repeat(4);

/** The bucket: the four renditions of one asset, and nothing else. */
const objects = new Map<string, Uint8Array>([
  [renditionKey(ASSET, 256, "webp"), new Uint8Array(WEBP)],
  [renditionKey(ASSET, 256, "png"), new Uint8Array(PNG)],
  [renditionKey(ASSET, 96, "webp"), new Uint8Array(WEBP)],
  [renditionKey(ASSET, 96, "png"), new Uint8Array(PNG)],
]);
const env = {
  BLOBS: {
    async get(key: string) {
      const bytes = objects.get(key);
      return bytes ? { arrayBuffer: async () => bytes.slice().buffer } : null;
    },
    async head(key: string) {
      return objects.has(key) ? {} : null;
    },
  },
} as unknown as Env;

let server: PreviewServer;
let browser: Browser;
let base: string;
const served: Array<{ path: string; type: string | null; status: number }> = [];

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
    reducedMotion: "reduce",
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
    const avatar = url.pathname.match(/^\/media\/avatar\/([^/]+)$/);
    if (avatar) {
      // The Worker's own handler, with the browser's own request headers (its `Accept`).
      const res = await serveAvatar(
        new Request(url.toString(), { headers: await request.allHeaders() }),
        env,
        avatar[1]!,
      );
      served.push({
        path: url.pathname,
        type: res.headers.get("content-type"),
        status: res.status,
      });
      return route.fulfill({
        status: res.status,
        headers: Object.fromEntries(res.headers),
        body: Buffer.from(await res.arrayBuffer()),
      });
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
  // The shell has rendered (signed out: the login card's one h1).
  await page.getByRole("heading", { level: 1 }).first().waitFor();
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

describe("account pictures under the Worker's CSP (PX-W16)", () => {
  it("the avatar response is an image that cannot be a document", async () => {
    const res = await serveAvatar(
      new Request(`https://key.plrs.im/media/avatar/${ASSET}.png`),
      env,
      `${ASSET}.png`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(AVATAR_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
  });

  it("same-origin /media/avatar pictures load with zero violations; the provider's host is blocked", async () => {
    const page = await open();
    expect(await violations(page), "portal shell").toEqual([]);

    for (const src of [
      `/media/avatar/${ASSET}`,
      `/media/avatar/${ASSET}-96.png`,
    ]) {
      const r = await addImage(page, src);
      expect(r, src).toEqual({ ok: true, width: 1 });
    }
    // Chromium takes WebP, so the negotiated picture came as WebP; the named one as PNG.
    expect(served).toContainEqual({
      path: `/media/avatar/${ASSET}`,
      type: "image/webp",
      status: 200,
    });
    expect(served).toContainEqual({
      path: `/media/avatar/${ASSET}-96.png`,
      type: "image/png",
      status: 200,
    });
    expect(await violations(page), "proxied avatars").toEqual([]);

    const direct = await addImage(
      page,
      "https://lh3.googleusercontent.com/a/ACg8ocK-mara=s96-c",
    );
    expect(direct.ok).toBe(false);
    const v = await violations(page);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/^img-src https:\/\/lh3\.googleusercontent\.com\//);
    await page.context().close();
  });
});
