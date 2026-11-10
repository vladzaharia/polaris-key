import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { CORE_ROUTES } from "./coreFixtures.js";
import { DATA_ROUTES } from "./layoutData.js";
import { closeContext } from "./teardown.js";

/**
 * Sign in with <Product> in the console (I-21.14): the Clients page, the client record and the
 * Platform issuer keys, in real Chromium under the Worker's CSP, at 390 and 1440 px, both themes
 * and 200 % text. Each state loads without CSP violations or sideways scroll; a secret is shown
 * once and is not in the page after the dialog closes.
 *
 * Set `PK_SHOTS_DIR` to also save a screenshot of each state.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const P = "/manage/api/products/djdl";

const ISSUER = "https://key.plrs.im/djdl/identity";
const client = (over: Record<string, unknown>) => ({
  id: "cl_AAAAAAAAAAAAAAAAAAAAAA",
  key: "forum",
  name: "Community forum",
  developerName: null,
  partner: false,
  type: "web",
  origin: "console",
  status: "active",
  redirectUris: ["https://forum.example.com/auth/callback"],
  postLogoutRedirectUris: ["https://forum.example.com/"],
  scopes: ["openid", "profile", "email", "offline_access"],
  claimsRequired: ["name"],
  createdAt: NOW - 30 * DAY,
  updatedAt: NOW - DAY,
  people30d: 42,
  people: 120,
  ...over,
});
const FORUM = client({});
const DOCS = client({
  id: "cl_BBBBBBBBBBBBBBBBBBBBBB",
  key: "docs",
  name: "Documentation site with a rather long name that must wrap",
  type: "spa",
  origin: "manifest",
  people30d: 7,
  people: 9,
});
const PARTNER = client({
  id: "cl_CCCCCCCCCCCCCCCCCCCCCC",
  key: "partner-app",
  name: "Partner companion",
  developerName: "Example Partner Ltd",
  partner: true,
  type: "native",
  status: "disabled",
  redirectUris: ["http://127.0.0.1/callback", "com.example.partner:/cb"],
  people30d: 0,
  people: 3,
});

const issuerSetting = (on: boolean) => ({
  key: "identity.issuer.enabled",
  area: "identity.platformSignIn",
  service: "identity",
  label: "Sign in with this product",
  description: "Whether clients you register may sign people in.",
  docs: "/docs/features/sign-in/",
  spec: { kind: "boolean" },
  confirm: { on: "L1", off: "L0" },
  critical: true,
  manifestPath: "product:identity.issuer.enabled",
  visibleWhen: { service: "identity", offBehaviour: "hide" },
  serviceEnabled: true,
  rbacArea: "keys",
  ownership: "claimable",
  value: on,
  source: "console",
  defaultValue: false,
  version: 1,
  updatedAt: NOW - DAY,
  updatedBy: "u1",
  reason: null,
});

const page_ = (clients: unknown[], on = true) => ({
  issuer: {
    enabled: on,
    url: ISSUER,
    discoveryUrl: `${ISSUER}/.well-known/openid-configuration`,
    jwksUrl: `${ISSUER}/jwks`,
  },
  limit: 20,
  clients,
});
const record = (c: unknown, secrets: unknown[] = []) => ({
  client: c,
  lastUsedAt: NOW - 3600,
  refreshIdleDays: 30,
  secrets,
  secretLimit: 2,
});
const SECRETS = [
  {
    id: "cs_1",
    hint: "pkeycs_…aB3x",
    createdAt: NOW - 20 * DAY,
    lastUsedAt: NOW - 600,
  },
  {
    id: "cs_2",
    hint: "pkeycs_…Q9zT",
    createdAt: NOW - 2 * DAY,
    lastUsedAt: null,
  },
];
const KEY = (
  n: string,
  state: string,
  extra: Record<string, unknown> = {},
) => ({
  kid: `${n.repeat(43)}`.slice(0, 43),
  state,
  publishedAt: NOW - 40 * DAY,
  activatedAt: state === "active" ? NOW - 40 * DAY : null,
  retiredAt: state === "retired" ? NOW - 5 * DAY : null,
  dueAt: state === "active" ? NOW + 50 * DAY : null,
  ...extra,
});

type Handler = (
  url: URL,
  method: string,
) => unknown | Promise<unknown> | undefined;

const base = (over: Record<string, unknown>): Record<string, unknown> => ({
  ...CORE_ROUTES,
  ...DATA_ROUTES,
  [`${P}/settings/effective`]: { settings: [issuerSetting(true)] },
  ...over,
});

const LIST = base({ [`${P}/identity/clients`]: page_([FORUM, DOCS, PARTNER]) });

let server: PreviewServer;
let browser: Browser;
let origin: string;

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
  origin = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server?.httpServer.close(() => r()));
});

async function open(
  theme: "dark" | "light",
  hash: string,
  routes: Record<string, unknown>,
  opts: { width?: number; handler?: Handler; text200?: boolean } = {},
): Promise<Page> {
  const width = opts.width ?? 1440;
  const ctx = await browser.newContext({
    viewport: { width, height: SHOTS ? 2000 : width < 600 ? 844 : 1000 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(
    ([t, big]) => {
      window.localStorage.setItem("pk-admin-theme", t as string);
      (window as unknown as { __v: string[] }).__v = [];
      document.addEventListener("securitypolicyviolation", (e) =>
        (window as unknown as { __v: string[] }).__v.push(
          `${e.violatedDirective} ${e.blockedURI} ${e.sample}`,
        ),
      );
      if (big)
        document.addEventListener("DOMContentLoaded", () => {
          document.documentElement.style.fontSize = "200%";
        });
    },
    [theme, opts.text200 === true],
  );
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/manage/api/")) {
      const custom = await opts.handler?.(url, route.request().method());
      if (custom instanceof Response)
        return route.fulfill({
          status: custom.status,
          json: await custom.json(),
        });
      const body = custom ?? routes[url.pathname];
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
  await page.goto(`${origin}/manage.html${hash}`);
  return page;
}

const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __v: string[] }).__v.splice(0));

async function check(
  page: Page,
  name: string,
  theme: string,
  width: number,
  text200 = false,
) {
  await page.waitForTimeout(400);
  if (SHOTS)
    await page.screenshot({
      path: `${SHOTS}/${name}-${width}-${theme}${text200 ? "-200" : ""}.png`,
      fullPage: true,
    });
  expect(await violations(page), `${name} CSP`).toEqual([]);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, `${name} sideways scroll at ${width}`).toBeLessThanOrEqual(
    1,
  );
}

const TITLE = "Sign in with DJDL";
const LIST_HASH = "#/p/djdl/identity/clients";
const title = (page: Page, text: string) =>
  page.locator("[data-page-title]", { hasText: text }).first().waitFor();

describe("Sign in with <Product> in the console", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1440, 390]) {
      for (const text200 of width === 390 ? [false, true] : [false]) {
        const tag = `${theme} ${width}${text200 ? " 200%" : ""}`;

        it(`the list, empty, off and failing (${tag})`, async () => {
          const states: [string, Record<string, unknown>][] = [
            ["list", LIST],
            ["list-empty", base({ [`${P}/identity/clients`]: page_([]) })],
            [
              "list-off",
              {
                ...base({ [`${P}/identity/clients`]: page_([FORUM], false) }),
                [`${P}/settings/effective`]: {
                  settings: [issuerSetting(false)],
                },
              },
            ],
          ];
          for (const [name, routes] of states) {
            const page = await open(theme, LIST_HASH, routes, {
              width,
              text200,
            });
            await title(page, TITLE);
            if (name === "list") {
              await page.getByText("Community forum").first().waitFor();
              await page.getByText("From .pkey").first().waitFor();
              await page.getByText("Disabled").first().waitFor();
              await page.getByText("by Example Partner Ltd").first().waitFor();
              await page.getByText(ISSUER).first().waitFor();
            }
            if (name === "list-empty")
              await page.getByText("No clients yet").waitFor();
            if (name === "list-off")
              await page
                .getByText("Sign in with this product is off")
                .first()
                .waitFor();
            await check(page, name, theme, width, text200);
            await closeContext(page.context());
          }
          const failing = await open(
            theme,
            LIST_HASH,
            { ...LIST, [`${P}/identity/clients`]: undefined },
            { width, text200 },
          );
          await failing
            .getByRole("button", { name: /try again|retry/i })
            .first()
            .waitFor();
          await check(failing, "list-error", theme, width, text200);
          await closeContext(failing.context());
        });

        it(`the register drawer, with refusals (${tag})`, async () => {
          const page = await open(theme, LIST_HASH, LIST, { width, text200 });
          await title(page, TITLE);
          await page
            .getByRole("button", { name: "Register client" })
            .first()
            .click();
          await page.getByRole("dialog").waitFor();
          const drawer = page.getByRole("dialog");
          await drawer.getByRole("textbox", { name: /^Name\b/ }).fill("Forum");
          expect(
            await drawer.getByRole("textbox", { name: /^Key\b/ }).inputValue(),
          ).toBe("forum");
          await drawer.getByRole("button", { name: "Register client" }).click();
          await page.getByText("Add at least one redirect address.").waitFor();
          await check(page, "register", theme, width, text200);
          await closeContext(page.context());
        });

        it(`the client record: web, public, manifest, disabled, missing (${tag})`, async () => {
          const cases: [string, unknown, string][] = [
            ["record-web", record(FORUM, SECRETS), "pkeycs_…aB3x"],
            [
              "record-spa",
              record({ ...FORUM, type: "spa" }),
              "holds no secret",
            ],
            ["record-manifest", record(DOCS), "Declared in .pkey/product"],
            ["record-disabled", record(PARTNER), "Disabled"],
          ];
          for (const [name, body, text] of cases) {
            const c = (body as { client: { id: string } }).client;
            const page = await open(
              theme,
              `${LIST_HASH}/${c.id}`,
              base({
                [`${P}/identity/clients`]: page_([FORUM, DOCS, PARTNER]),
                [`${P}/identity/clients/${c.id}`]: body,
              }),
              { width, text200 },
            );
            await page.getByText(text).first().waitFor();
            await check(page, name, theme, width, text200);
            await closeContext(page.context());
          }
          const missing = await open(theme, `${LIST_HASH}/cl_nope`, LIST, {
            width,
            text200,
          });
          await missing.getByText("Client not found").first().waitFor();
          await check(missing, "record-missing", theme, width, text200);
          await closeContext(missing.context());
        });
      }

      it(`a minted secret is shown once, with its prefix (${theme} ${width})`, async () => {
        const secret = `pkeycs_${"Z".repeat(43)}`;
        const page = await open(
          theme,
          `${LIST_HASH}/${FORUM.id}`,
          base({
            [`${P}/identity/clients`]: page_([FORUM]),
            [`${P}/identity/clients/${FORUM.id}`]: record(FORUM, [SECRETS[0]]),
          }),
          {
            width,
            handler: (url, method) =>
              method === "POST" && url.pathname.endsWith("/secrets")
                ? {
                    ok: true,
                    secret: { id: "cs_3", value: secret, hint: "pkeycs_…ZZZZ" },
                  }
                : undefined,
          },
        );
        await page
          .getByRole("button", { name: "Generate secret" })
          .first()
          .click();
        await page
          .getByRole("alertdialog")
          .getByRole("button", { name: "Generate secret" })
          .click();
        await page.getByText(secret).first().waitFor();
        await check(page, "secret-once", theme, width);
        await page.getByLabel("I've stored it").check();
        await page.getByRole("button", { name: "Done" }).click();
        await page.getByRole("dialog").waitFor({ state: "detached" });
        expect(await page.content()).not.toContain(secret);
        await closeContext(page.context());
      });
    }

    it(`Platform issuer keys (${theme})`, async () => {
      const routes = {
        ...base({}),
        "/manage/api/platform/issuer-keys": {
          products: [
            {
              slug: "djdl",
              name: "DJDL",
              issuerOn: true,
              keys: [
                KEY("a", "active"),
                KEY("b", "next", { dueAt: NOW + 50 * DAY }),
                KEY("c", "retired"),
              ],
            },
          ],
        },
      };
      for (const width of [1440, 390]) {
        const page = await open(theme, "#/platform/settings", routes, {
          width,
        });
        await page
          .locator("#platform-advanced")
          .getByRole("button", { name: "Show" })
          .click();
        await page.getByText("Issuer keys").first().waitFor();
        await page
          .getByRole("button", { name: "Rotate now" })
          .first()
          .waitFor();
        const keys = page.locator("#platform-issuer-keys");
        await keys.scrollIntoViewIfNeeded();
        if (SHOTS)
          await keys.screenshot({
            path: `${SHOTS}/platform-issuer-keys-${width}-${theme}.png`,
          });
        expect(await violations(page), "issuer keys CSP").toEqual([]);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth,
          ),
          `issuer keys sideways scroll at ${width}`,
        ).toBeLessThanOrEqual(1);
        await closeContext(page.context());
      }
    });
  }
});
