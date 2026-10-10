import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/platform/securityHeaders.js";
import {
  MEDIA_CSP,
  MEDIA_IMMUTABLE,
  MEDIA_SHORT,
  mediaResponseHeaders,
} from "../../worker/src/services/identity/portal/media.js";
import {
  IMG_ALIAS_CACHE,
  IMG_CSP,
  IMG_IMMUTABLE,
  hardenImgHostResponse,
} from "../../worker/src/core/assets/imgHost.js";

/**
 * The portal never loads art from a developer's host (docs/design/PORTAL.md G1). Since HA-07 it
 * shows Polaris Key's hosted copies on the image host, and its shell's CSP adds exactly that origin
 * (`img-src 'self' data: <IMG_ORIGIN>`); the same-origin `/media/<product>/<asset>` route 302s to
 * the image host's stable alias. In HA-10's rollback (hosting off) the policy is PX-W1's
 * `img-src 'self' data:` and `/media` is the proxy again.
 *
 * This loads the BUILT portal under the Worker's exact policy and proves, in real Chromium:
 *   - image-host URLs (an original, a WebP width, and the stable alias that redirects to one),
 *     answered with the image host's own headers (`hardenImgHostResponse`), load and decode with
 *     zero violations, including as an anonymous CORS load (the icon's corner-pixel read);
 *   - `/media/<product>/icon` follows its 302 to the image host with zero violations;
 *   - the same art requested straight from its GitHub host is still blocked by the page's policy;
 *   - under the rollback's policy the proxy's own `/media` answer still loads (PX-W1).
 *
 * The image host is a real local HTTP server answering with the host's own headers: a redirect a
 * route fulfils is followed over the network, not back through the route, so the alias chain
 * (`/media` → the alias → the copy) needs a server at the far end. `cspImageOrigin` admits a
 * loopback `http:` origin for exactly this kind of local host.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const SHA = "a".repeat(64);
/** The local image host's origin and the portal policy that names it (set in `beforeAll`). */
let IMG = "";
let HOSTED_CSP = "";
let imgServer: Server;
const ROLLBACK_CSP = appSecurityHeaders().get("content-security-policy")!;
// A real 1×1 PNG, so `naturalWidth` proves the browser decoded it.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let server: PreviewServer;
let browser: Browser;
let base: string;
/** What each test's page asked `/media` and the image host for (emptied before every test). */
const mediaHits: string[] = [];
const imgHits: string[] = [];

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
  imgServer = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    imgHits.push(pathname);
    const answer = imgHostFor(pathname);
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  });
  await new Promise<void>((r) => imgServer.listen(0, "127.0.0.1", r));
  const address = imgServer.address();
  IMG = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  HOSTED_CSP = appSecurityHeaders(undefined, { imgOrigin: IMG }).get(
    "content-security-policy",
  )!;
  // The portal document is answered through `route.fulfill` (to carry the Worker's policy), so
  // Chromium cannot place it in the loopback address space and its Local Network Access check
  // would refuse every request to the local image host. That check is about LAN access, not the
  // page's CSP this suite proves, so it is off here.
  browser = await chromium.launch({
    args: [
      "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults",
    ],
  });
});

beforeEach(() => {
  mediaHits.length = 0;
  imgHits.length = 0;
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server?.httpServer.close(() => r()));
  await new Promise<void>((r) => imgServer?.close(() => r()));
});

/** An image-host answer, with the host's own headers. */
function imgHostAnswer(
  status: number,
  headers: Record<string, string>,
  body?: Buffer,
) {
  const res = hardenImgHostResponse(new Response(null, { status, headers }));
  return {
    status,
    headers: Object.fromEntries(res.headers),
    ...(body ? { body } : {}),
  };
}

/** The image host's paths, as `core/imgHost.ts` answers them: the alias 302s to the copy. */
function imgHostFor(pathname: string) {
  const alias = /^\/([a-z0-9-]+)\/(icon|header)$/.exec(pathname);
  if (alias)
    return imgHostAnswer(302, {
      location: `${IMG}/${alias[1]}/a/${SHA}`,
      "cache-control": IMG_ALIAS_CACHE,
    });
  if (/^\/[a-z0-9-]+\/a\/[0-9a-f]{64}(\/[0-9]+\.webp)?$/.test(pathname))
    return imgHostAnswer(
      200,
      {
        "content-type": "image/png",
        "content-length": String(PNG.byteLength),
        "cache-control": IMG_IMMUTABLE,
        "content-disposition": "inline",
        etag: `"${SHA}"`,
      },
      PNG,
    );
  return imgHostAnswer(404, { "content-type": "application/json" });
}

async function open(mode: "hosted" | "rollback" = "hosted"): Promise<Page> {
  const CSP = mode === "hosted" ? HOSTED_CSP : ROLLBACK_CSP;
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
    // The image host is the real local server: let the request through.
    if (url.origin === IMG) return route.continue();
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
      if (mode === "hosted") {
        // HA-07: a redirect to the image host's stable alias, fetching nothing.
        const asset = url.pathname.split("/").slice(2, 4).join("/");
        const headers = Object.fromEntries(
          mediaResponseHeaders({
            location: `${IMG}/${asset}`,
            "cache-control": MEDIA_SHORT,
          }),
        );
        return route.fulfill({ status: 302, headers });
      }
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
  // The shell has rendered (signed out: the login card's one h1). Not `#root *`: the first
  // element can be the toaster's hidden live region, which never becomes visible.
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  return page;
}

const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __v: string[] }).__v.splice(0));

/** Add an <img> through the DOM (not inline script) and wait for it to settle. With `cors`, an
 *  anonymous CORS load whose pixels a canvas can read (the portal icon's `iconShape`). */
const addImage = (page: Page, src: string, cors = false) =>
  page.evaluate(
    ([s, c]) =>
      new Promise<{ ok: boolean; width: number; readable?: boolean }>(
        (resolve) => {
          const img = document.createElement("img");
          img.alt = "";
          if (c) img.crossOrigin = "anonymous";
          img.onload = () => {
            if (!c) return resolve({ ok: true, width: img.naturalWidth });
            let readable = true;
            try {
              const canvas = document.createElement("canvas");
              canvas.width = canvas.height = 1;
              const ctx = canvas.getContext("2d")!;
              ctx.drawImage(img, 0, 0);
              ctx.getImageData(0, 0, 1, 1);
            } catch {
              readable = false;
            }
            resolve({ ok: true, width: img.naturalWidth, readable });
          };
          img.onerror = () => resolve({ ok: false, width: 0 });
          img.src = s as string;
          document.body.appendChild(img);
        },
      ),
    [src, cors] as const,
  );

describe("portal art under the Worker's CSP (HA-07; PX-W1 as the rollback)", () => {
  it("the image host's and the media route's own answers are images that cannot be documents", () => {
    const h = mediaResponseHeaders({ "content-type": "image/png" });
    expect(h.get("content-security-policy")).toBe(MEDIA_CSP);
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("cross-origin-resource-policy")).toBe("same-origin");
    const img = imgHostAnswer(200, { "content-type": "image/png" }).headers;
    expect(img["content-security-policy"]).toBe(IMG_CSP);
    expect(img["x-content-type-options"]).toBe("nosniff");
    expect(img["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(img["access-control-allow-origin"]).toBe("*");
    expect(HOSTED_CSP).toContain(`img-src 'self' data: ${IMG}`);
  });

  it("hosted copies on the image host load with zero violations; a raw GitHub image is still blocked", async () => {
    const page = await open("hosted");
    expect(await violations(page), "portal shell").toEqual([]);

    for (const src of [
      `${IMG}/tidewater/a/${SHA}/256.webp`,
      `${IMG}/tidewater/a/${SHA}`,
      `${IMG}/tidewater/icon`,
    ]) {
      const r = await addImage(page, src);
      expect(r, src).toEqual({ ok: true, width: 1 });
    }
    // The icon's anonymous CORS load: it decodes, and its pixels are readable (`iconShape`).
    expect(
      await addImage(page, `${IMG}/tidewater/a/${SHA}/128.webp`, true),
    ).toEqual({ ok: true, width: 1, readable: true });
    // A URL already handed out: `/media` 302s to the image host's alias, which 302s to the copy.
    expect(
      await addImage(page, "/media/tidewater/icon?v=3f9a0c2d1e4b5a6c"),
    ).toEqual({
      ok: true,
      width: 1,
    });
    expect(mediaHits).toContain("/media/tidewater/icon?v=3f9a0c2d1e4b5a6c");
    expect(imgHits).toContain("/tidewater/icon");
    expect(await violations(page), "hosted art").toEqual([]);

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

  it("rollback: same-origin /media images load with zero violations; the direct host is blocked", async () => {
    const page = await open("rollback");
    expect(await violations(page), "portal shell").toEqual([]);

    for (const src of [
      "/media/tidewater/icon?v=3f9a0c2d1e4b5a6c",
      "/media/tidewater/header?v=8b7c6d5e4f3a2b1c",
    ]) {
      const r = await addImage(page, src);
      expect(r, src).toEqual({ ok: true, width: 1 });
    }
    expect(await violations(page), "proxied art").toEqual([]);
    // The proxy answered both itself; the image host was never asked.
    expect(mediaHits).toEqual([
      "/media/tidewater/icon?v=3f9a0c2d1e4b5a6c",
      "/media/tidewater/header?v=8b7c6d5e4f3a2b1c",
    ]);
    expect(imgHits).toEqual([]);

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
