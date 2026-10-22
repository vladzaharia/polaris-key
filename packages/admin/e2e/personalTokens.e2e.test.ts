/**
 * The Superadmin's Personal tokens roster (`#/personal-tokens`, F-33) in real Chromium under the
 * Worker's CSP, with a 66-character label and a 75-character email: the table must fit 1280 and
 * 1440 px (Status, Expires, Last used and Actions on screen, no sideways scroll inside its
 * scroller), with no CSP violation and no page-level scroll. With PK_SHOTS_DIR set it saves each
 * render.
 */

import { closeContext } from "./teardown.js";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;
const NOW = Math.floor(Date.now() / 1000);

const ME = {
  sub: "root",
  name: "Root Admin",
  email: "root@example.com",
  csrf: "c",
  platformAdmin: true,
  sessionExpiresAt: NOW + 3600,
  products: [],
};
const row = (over: Record<string, unknown>) => ({
  id: "pt_a",
  email: "ada@example.com",
  label: "Ada laptop",
  hint: "Hq2a",
  scope: "packages:read",
  createdAt: NOW - 60 * 86400,
  expiresAt: NOW + 90 * 86400,
  lastUsedAt: NOW - 3600,
  revokedAt: null,
  revokeReason: null,
  status: "active",
  ...over,
});
const TOKENS = [
  row({}),
  row({
    id: "pt_long",
    label:
      "A deliberately long label for a build server in the Tidewater cluster",
    email:
      "someone.with.an.extraordinarily.long.address.for.testing@a-very-long-company-domain.example.com",
  }),
  row({
    id: "pt_rev",
    label: "Old",
    status: "revoked",
    revokedAt: NOW - 86400,
    revokeReason: "admin",
  }),
];

let server: PreviewServer;
let browser: Browser;
let base: string;
beforeAll(async () => {
  if (!existsSync(`${here}dist/manage.html`))
    throw new Error(
      "Build the console first: pnpm --filter @polaris-key/admin build",
    );
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  server = await preview({
    root: here,
    configFile: `${here}vite.config.ts`,
    preview: { port: 0, strictPort: false, host: "127.0.0.1" },
    logLevel: "silent",
  });
  base = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => server?.httpServer.close(() => done()));
});

describe.concurrent("Personal tokens roster", () => {
  for (const s of [
    { w: 1280, h: 800, theme: "dark" },
    { w: 1440, h: 900, theme: "light" },
    { w: 390, h: 844, theme: "dark" },
  ] as const) {
    it(`fits at ${s.w} (${s.theme})`, async () => {
      const ctx = await browser.newContext({
        viewport: { width: s.w, height: s.h },
        colorScheme: s.theme,
        reducedMotion: "reduce",
      });
      await ctx.addInitScript((t) => {
        window.localStorage.setItem("pk-admin-theme", t);
        (window as unknown as { __v: string[] }).__v = [];
        document.addEventListener("securitypolicyviolation", (e) =>
          (window as unknown as { __v: string[] }).__v.push(
            `${e.violatedDirective} ${e.blockedURI}`,
          ),
        );
      }, s.theme);
      const routes: Record<string, unknown> = {
        "/manage/api/me": ME,
        "/manage/api/products": { products: [] },
        "/manage/api/attention": { items: [] },
        "/manage/api/account-tokens": { tokens: TOKENS },
      };
      await ctx.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith("/manage/api/")) {
          const body = routes[url.pathname];
          return body
            ? route.fulfill({ json: body })
            : route.fulfill({ status: 404, json: { error: "not_found" } });
        }
        const res = await route.fetch();
        const headers = { ...res.headers() };
        if (url.pathname.endsWith(".html"))
          headers["content-security-policy"] = CSP;
        return route.fulfill({ response: res, headers });
      });
      const page = await ctx.newPage();
      try {
        await page.goto(`${base}/manage.html#/personal-tokens`);
        await page
          .getByRole("heading", { level: 1, name: "Personal tokens" })
          .waitFor();
        await page.getByText("Ada laptop").first().waitFor();
        if (SHOTS)
          await page.screenshot({
            path: `${SHOTS}/console.personal-tokens-${s.w}-${s.theme}.png`,
            fullPage: true,
          });
        expect(
          await page.evaluate(
            () => (window as unknown as { __v: string[] }).__v,
          ),
        ).toEqual([]);
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          ),
        ).toBeLessThanOrEqual(0);
        if (s.w >= 1024) {
          // Every column fits: no table scroller scrolls sideways.
          const over = await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>("table")]
              .map((t) => {
                const sc = t.parentElement!;
                return sc.scrollWidth - sc.clientWidth;
              })
              .filter((d) => d > 1),
          );
          expect(over).toEqual([]);
          await page
            .getByRole("button", { name: "Actions for Ada laptop" })
            .waitFor({ state: "visible" });
        }
      } finally {
        await closeContext(ctx);
      }
    });
  }
});
