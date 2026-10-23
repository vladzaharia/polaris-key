import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { preview, type PreviewServer } from "vite";
import { closeContext } from "./teardown.js";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { CORE_ROUTES } from "./coreFixtures.js";

/**
 * A-27.12 in the BUILT console under the Worker's CSP: on Settings → Presentation → Listing,
 * "Revert to manifest" (preview, confirm, apply that one field with the digest) and "Use
 * Presentation" (the listing PUT) change the field's source pill. The API is a small stateful
 * stand-in. With `PK_SHOTS_DIR` set it saves the page and the Presentation rows.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;
const LISTING = "/manage/api/products/djdl/distribution/listing";

let server: PreviewServer;
let browser: Browser;
let base: string;

beforeAll(async () => {
  if (!existsSync(`${here}dist/manage.html`))
    throw new Error(
      "Build the console first: pnpm --filter @polaris-key/admin build",
    );
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

describe("listing sources, Revert to manifest and Use Presentation", () => {
  it("round-trips both against a stateful API, with no CSP violation", async () => {
    const state = {
      name: "Typed Name" as string | null,
      developer: "Dev",
      developerSource: "app-store",
    };
    const posts: unknown[] = [];
    const puts: unknown[] = [];
    const model = () => ({
      listing: {
        app: {
          defaultLocale: "en-US",
          ...(state.name ? { name: state.name } : {}),
          developerName: state.developer,
        },
        source: "admin",
        provenance: { developerName: state.developerSource },
        modifiedAt: 1,
        modifiedBy: "u1",
      },
      locales: [],
      overrides: [],
      limits: {},
      ...(state.name ? {} : { inherited: { name: "presentation" } }),
    });
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: SHOTS ? 2000 : 1000 },
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
      const req = route.request();
      const url = new URL(req.url());
      if (!url.pathname.startsWith("/manage/api/")) {
        const res = await route.fetch();
        const headers = { ...res.headers() };
        if (url.pathname.endsWith(".html"))
          headers["content-security-policy"] = CSP;
        return route.fulfill({ response: res, headers });
      }
      if (url.pathname === LISTING) {
        if (req.method() === "PUT") {
          const body = req.postDataJSON() as { app?: { name?: null } };
          puts.push(body);
          if (body.app && "name" in body.app) state.name = null;
          return route.fulfill({ json: model() });
        }
        return route.fulfill({ json: model() });
      }
      if (url.pathname === `${LISTING}/import`) {
        const body = req.postDataJSON() as { confirm?: string };
        posts.push(body);
        if (body.confirm) {
          state.developer = "Repo Dev";
          state.developerSource = "manifest";
        }
        return route.fulfill({
          json: {
            ...model(),
            import: {
              applied: !!body.confirm,
              digest: "d1",
              createsListing: false,
              defaultLocale: "en-US",
              sources: [{ source: "manifest", ref: "root", ok: true }],
              changes: [
                {
                  field: "developerName",
                  locale: null,
                  action: "replace",
                  current: "Dev",
                  currentSource: "app-store",
                  proposed: "Repo Dev",
                  proposedSource: "manifest",
                  reason: null,
                },
              ],
              refused: [],
              skipped: [],
              written: body.confirm ? ["developerName"] : [],
            },
          },
        });
      }
      if (url.pathname.endsWith("/distribution/storefronts"))
        return route.fulfill({ json: { stores: [], listing: null } });
      const extra: Record<string, unknown> = {
        "/manage/api/products/djdl/assets": { assets: [] },
        "/manage/api/products/djdl/assets/usage": {
          hosting: true,
          media: { full: false },
          release: { full: false },
          settings: [],
        },
      };
      const body = extra[url.pathname] ?? CORE_ROUTES[url.pathname];
      return body
        ? route.fulfill({ json: body })
        : route.fulfill({ status: 404, json: { error: "not_found" } });
    });
    const page = await ctx.newPage();
    await page.goto(
      `${base}/manage.html#/p/djdl/settings/presentation/listing`,
    );
    await page.getByText("Developer name", { exact: true }).first().waitFor();

    // Revert to manifest: the preview first, the apply only after the confirm.
    await page
      .getByRole("button", { name: "Revert to manifest" })
      .last()
      .click();
    await page.getByText("Manifest: Repo Dev").waitFor();
    expect(posts).toEqual([
      { sources: [{ source: "manifest" }], overwrite: true },
    ]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/revert-confirm.png` });
    await page.getByRole("button", { name: "Revert", exact: true }).click();
    await page
      .getByText("App Store", { exact: true })
      .waitFor({ state: "detached" });
    expect(posts[1]).toEqual({
      sources: [{ source: "manifest" }],
      overwrite: true,
      fields: ["developerName"],
      confirm: "d1",
    });

    // Use Presentation: the name goes back to the product's.
    await page.getByRole("button", { name: "Use Presentation" }).click();
    await page.getByText("From Presentation").waitFor();
    expect(puts).toEqual([{ app: { name: null } }]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/listing-text.png` });

    await page.goto(`${base}/manage.html#/p/djdl/settings/presentation`);
    await page.getByText("Name, accent and description").waitFor();
    if (SHOTS)
      await page.screenshot({
        path: `${SHOTS}/presentation-rows.png`,
        fullPage: true,
      });

    expect(
      await page.evaluate(() => (window as unknown as { __v: string[] }).__v),
    ).toEqual([]);
    await closeContext(ctx);
  });
});
