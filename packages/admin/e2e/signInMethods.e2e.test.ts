/**
 * The operator's Sign-in methods (`#/account/sign-in-methods`, ST-30c.4) in real Chromium under the
 * Worker's CSP, every state at 1440 dark and 390 light: no CSP violation, no sideways scroll, and
 * the dialogs inside the window. With PK_SHOTS_DIR set it saves each state.
 */

import { closeContext } from "./teardown.js";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;
const NOW = Math.floor(Date.now() / 1000);

const ME = {
  sub: "u1",
  name: "Ada Lovelace",
  email: "ada@example.com",
  csrf: "c",
  platformAdmin: true,
  sessionExpiresAt: NOW + 3600,
  authAt: NOW - 3 * 3600,
  customerOrigin: "https://polaris.locker",
  products: [],
};
const OIDC = {
  id: "lnk_oidc",
  kind: "oidc",
  name: "ada@example.com",
  createdAt: NOW - 90 * 86400,
  lastUsedAt: NOW - 3600,
  strong: true,
  consoleEligible: false,
};
const LOCKER_PK = {
  id: "lnk_pk",
  kind: "passkey",
  name: "A deliberately long passkey name for the YubiKey in the Tidewater office",
  createdAt: NOW - 30 * 86400,
  lastUsedAt: null,
  strong: false,
  consoleEligible: true,
};

type Body = unknown | { status: number; json: unknown };
interface Scenario {
  methods?: Body;
  options?: Body;
  strong?: Body;
  me?: Record<string, unknown>;
  /** Make `navigator.credentials.create` reject with this DOMException name. */
  browser?: "NotAllowedError";
}

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

const reply = (body: Body) =>
  typeof body === "object" && body !== null && "status" in body
    ? {
        status: (body as { status: number }).status,
        json: (body as { json: unknown }).json,
      }
    : { json: body };

const VIEWS = [
  { w: 1440, h: 900, theme: "dark" },
  { w: 390, h: 844, theme: "light" },
] as const;

async function run(
  name: string,
  sc: Scenario,
  drive: (page: Page) => Promise<void>,
): Promise<void> {
  await Promise.all(
    VIEWS.map(async (v) => {
      const ctx = await browser.newContext({
        viewport: { width: v.w, height: v.h },
        colorScheme: v.theme,
        reducedMotion: "reduce",
      });
      await ctx.addInitScript(
        ([t, br]) => {
          window.localStorage.setItem("pk-admin-theme", t as string);
          (window as unknown as { __v: string[] }).__v = [];
          document.addEventListener("securitypolicyviolation", (e) =>
            (window as unknown as { __v: string[] }).__v.push(
              `${e.violatedDirective} ${e.blockedURI}`,
            ),
          );
          if (br)
            navigator.credentials.create = () =>
              Promise.reject(new DOMException("cancelled", br as string));
        },
        [v.theme, sc.browser ?? null],
      );
      const routes: Record<string, Body> = {
        "/manage/api/me": { ...ME, ...sc.me },
        "/manage/api/products": { products: [] },
        "/manage/api/attention": { items: [] },
        "/manage/api/me/methods": sc.methods ?? { methods: [OIDC, LOCKER_PK] },
        "/manage/api/me/passkeys/options": sc.options ?? {
          options: {
            challenge: "YQ",
            user: { id: "dQ", name: "ada", displayName: "Ada" },
          },
        },
        "/manage/api/me/methods/lnk_pk/strong": sc.strong ?? { ok: true },
      };
      await ctx.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith("/manage/api/")) {
          const body = routes[url.pathname];
          return body === undefined
            ? route.fulfill({ status: 404, json: { error: "not_found" } })
            : route.fulfill(reply(body));
        }
        const res = await route.fetch();
        const headers = { ...res.headers() };
        if (url.pathname.endsWith(".html"))
          headers["content-security-policy"] = CSP;
        return route.fulfill({ response: res, headers });
      });
      const page = await ctx.newPage();
      try {
        await page.goto(`${base}/manage.html#/account/sign-in-methods`);
        await page
          .getByRole("heading", { level: 1, name: "Sign-in methods" })
          .waitFor();
        await drive(page);
        if (SHOTS)
          await page.screenshot({
            path: `${SHOTS}/${name}--${v.w}-${v.theme}.png`,
            fullPage: false,
          });
        expect(
          await page.evaluate(
            () => (window as unknown as { __v: string[] }).__v,
          ),
          "CSP violations",
        ).toEqual([]);
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          ),
          "page-level horizontal scroll",
        ).toBeLessThanOrEqual(0);
        const dialog = page.getByRole("alertdialog");
        if ((await dialog.count()) > 0) {
          const box = (await dialog.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(v.w);
          expect(box.y + box.height).toBeLessThanOrEqual(v.h + 1);
        }
      } finally {
        await closeContext(ctx);
      }
    }),
  );
}

const listed = (page: Page) =>
  page.getByText("Opens the console").first().waitFor();
const openAdd = async (page: Page) => {
  await page.getByRole("button", { name: "Add a passkey" }).first().click();
  await page.getByRole("alertdialog").waitFor();
};
const openUse = async (page: Page) => {
  await page.getByRole("button", { name: /Use .* for the console/ }).click();
  await page.getByRole("alertdialog").waitFor();
};
const confirm = (page: Page, name: string) =>
  page.getByRole("alertdialog").getByRole("button", { name }).click();

describe.concurrent("Sign-in methods", () => {
  it("list", () => run("list", {}, listed));
  it("empty", () =>
    run("empty", { methods: { methods: [] } }, (p) =>
      p.getByText("No sign-in methods").waitFor(),
    ));
  it("error", () =>
    run("error", { methods: { status: 500, json: { error: "boom" } } }, (p) =>
      p.getByRole("button", { name: /Try again/ }).waitFor(),
    ));
  it("add: confirm", () =>
    run("add-confirm", {}, async (p) => {
      await listed(p);
      await openAdd(p);
    }));
  it("add: cancelled by the browser", () =>
    run("add-cancelled", { browser: "NotAllowedError" }, async (p) => {
      await listed(p);
      await openAdd(p);
      await confirm(p, "Add passkey");
      await p.getByText("Nothing was added").waitFor();
    }));
  it("add: sign in again", () =>
    run(
      "step-up",
      {
        options: { status: 403, json: { error: { code: "step_up_required" } } },
      },
      async (p) => {
        await listed(p);
        await openAdd(p);
        await confirm(p, "Add passkey");
        await p.getByText("Sign in again to confirm it's you").waitFor();
      },
    ));
  it("use for the console: confirm", () =>
    run("use-confirm", {}, async (p) => {
      await listed(p);
      await openUse(p);
    }));
  it("use for the console: not eligible", () =>
    run(
      "use-not-eligible",
      {
        strong: {
          status: 403,
          json: { error: { code: "forbidden", reason: "not_eligible" } },
        },
      },
      async (p) => {
        await listed(p);
        await openUse(p);
        await confirm(p, "Use for the console");
        await p.getByText("This passkey can't be used here").waitFor();
      },
    ));
  it("use for the console: already strong", () =>
    run(
      "use-already-strong",
      {
        strong: {
          status: 409,
          json: { error: { code: "forbidden", reason: "already_strong" } },
        },
      },
      async (p) => {
        await listed(p);
        await openUse(p);
        await confirm(p, "Use for the console");
        await p.getByText("This passkey already signs you in here").waitFor();
      },
    ));
  it("break-glass", () =>
    run("break-glass", { me: { breakGlass: true } }, (p) =>
      p.getByText("Emergency sign-in can't manage sign-in methods").waitFor(),
    ));
});
