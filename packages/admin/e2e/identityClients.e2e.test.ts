import { closeContext } from "./teardown.js";
import { CORE_ROUTES } from "./coreFixtures.js";
import { DATA_ROUTES } from "./layoutData.js";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { preview, type PreviewServer } from "vite";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Sign in with <Product> in the console (I-21.14): the Clients page, the client record and the
 * Platform issuer keys, in real Chromium under the Worker's CSP, at 390 and 1440 px, both themes
 * and 200 % text. Each state loads without CSP violations or sideways scroll; a secret is shown
 * once and is not in the page after the dialog closes.
 *
 * Set `PK_SHOTS_DIR` to also save a screenshot of each state.
 */

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const P = "/manage/api/products/djdl";
const SHOTS = process.env.PK_SHOTS_DIR;
const CSP = appSecurityHeaders().get("content-security-policy")!;
const here = fileURLToPath(new URL("..", import.meta.url));

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
  confirm: { on: "L1", off: "L1" },
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

/** What the browser's CSP refused on each page the test opened. */
const refusals = new WeakMap<Page, string[]>();

const app: { site?: PreviewServer; chrome?: Browser; url: string } = {
  url: "",
};

beforeAll(async () => {
  const built = `${here}dist/manage.html`;
  if (!existsSync(built))
    throw new Error(
      "Build the console first: pnpm --filter @polaris-key/admin build",
    );
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  app.site = await preview({
    configFile: `${here}vite.config.ts`,
    root: here,
    logLevel: "silent",
    preview: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  app.url = (app.site.resolvedUrls?.local[0] ?? "").replace(/\/$/, "");
  app.chrome = await chromium.launch();
});

afterAll(async () => {
  await app.chrome?.close();
  await new Promise<void>((done) => app.site?.httpServer.close(() => done()));
});

/** Answer an admin API call from the scripted routes, or from `handler` when it has a reply. */
async function answer(
  routes: Record<string, unknown>,
  handler: Handler | undefined,
  url: URL,
  method: string,
): Promise<{ status: number; json: unknown }> {
  const given = await handler?.(url, method);
  if (given instanceof Response)
    return { status: given.status, json: await given.json() };
  const known = given ?? routes[url.pathname];
  return known
    ? { status: 200, json: known }
    : { status: 404, json: { error: "not_found" } };
}

async function open(
  theme: "dark" | "light",
  hash: string,
  routes: Record<string, unknown>,
  opts: { width?: number; handler?: Handler; text200?: boolean } = {},
): Promise<Page> {
  const width = opts.width ?? 1440;
  const context = await app.chrome!.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    viewport: { height: SHOTS ? 2000 : width < 600 ? 844 : 1000, width },
  });
  await context.addInitScript(
    ([mode, enlarge]) => {
      window.localStorage.setItem("pk-admin-theme", mode as string);
      if (enlarge)
        document.addEventListener("DOMContentLoaded", () => {
          document.documentElement.style.fontSize = "200%";
        });
    },
    [theme, opts.text200 === true],
  );
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/manage/api/")) {
      const reply = await answer(
        routes,
        opts.handler,
        url,
        route.request().method(),
      );
      return route.fulfill({ status: reply.status, json: reply.json });
    }
    const upstream = await route.fetch();
    const headers = { ...upstream.headers() };
    if (url.pathname.endsWith(".html"))
      headers["content-security-policy"] = CSP;
    return route.fulfill({ response: upstream, headers });
  });
  const page = await context.newPage();
  const refused: string[] = [];
  page.on("console", (m) => {
    if (/content security policy/i.test(m.text())) refused.push(m.text());
  });
  await page.goto(`${app.url}/manage.html${hash}`);
  refusals.set(page, refused);
  return page;
}

const violations = async (page: Page): Promise<string[]> =>
  refusals.get(page)?.splice(0) ?? [];

async function check(
  page: Page,
  name: string,
  theme: string,
  width: number,
  text200 = false,
) {
  // brittle-ok: a CSP report has no completion signal; the beat lets late reports arrive first
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

const TITLE = "Clients";
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
                .getByText("Sign in with DJDL is off")
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
            ["record-manifest", record(DOCS), "From .pkey/product"],
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

  describe("the flows that need state", () => {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const STEP_UP = () =>
      json(403, {
        error: {
          code: "step_up_required",
          message:
            "Sign in again to confirm it's you. This needs a sign-in from the last 5 minutes.",
        },
        code: "step_up_required",
      });
    /** "Sign in again" leaves for the sign-in; coming back is opening the same page again. */
    const signInAgain = async (page: Page, button: Locator, hash: string) => {
      await button.click();
      await page.waitForURL(/\/manage\/login/);
      await page.goto(`${app.url}/manage.html${hash}`);
    };

    /** Escape asks before it drops the entries, and Keep editing leaves the drawer open. */
    const keepsEntries = async (page: Page) => {
      await page.keyboard.press("Escape");
      await page.getByText("Discard your changes?").waitFor();
      await page.getByRole("button", { name: /keep editing/i }).click();
      await page.getByRole("dialog").waitFor();
    };

    /** The client record of the forum, with one secret, answering `handler` first. */
    const openForum = (hash: string, handler: Handler) =>
      open(
        "light",
        hash,
        base({
          [`${P}/identity/clients`]: page_([FORUM]),
          [`${P}/identity/clients/${FORUM.id}`]: record(FORUM, [SECRETS[0]]),
        }),
        { handler },
      );

    it("turning the provider on from the first run makes Register ready without a reload", async () => {
      let on = false;
      const page = await open(
        "light",
        LIST_HASH,
        base({ [`${P}/identity/clients`]: page_([], false) }),
        {
          handler: (url, method) => {
            if (url.pathname === `${P}/identity/clients`) return page_([], on);
            if (url.pathname === `${P}/settings/effective`)
              return { settings: [issuerSetting(on)] };
            if (
              method === "PATCH" &&
              url.pathname === `${P}/settings/identity.issuer.enabled`
            ) {
              on = true;
              return { ok: true, claimed: true, setting: issuerSetting(true) };
            }
            return undefined;
          },
        },
      );
      await title(page, TITLE);
      await page
        .getByRole("button", { name: "Turn on Sign in with DJDL" })
        .waitFor();
      // The step is the one primary: no disabled Register above it.
      expect(
        await page.getByRole("button", { name: "Register client" }).count(),
      ).toBe(0);
      await page
        .getByRole("button", { name: "Turn on Sign in with DJDL" })
        .click();
      const dialog = page.getByRole("alertdialog");
      await dialog.getByRole("textbox").fill("First client");
      await dialog.getByRole("button", { name: "Turn on" }).click();
      await page.getByText(ISSUER).first().waitFor();
      const register = page
        .getByRole("button", { name: "Register client" })
        .first();
      await register.waitFor();
      expect(await register.getAttribute("aria-disabled")).not.toBe("true");
      await closeContext(page.context());
    });

    it("a key you typed survives the step-up sign-in", async () => {
      const page = await open("light", LIST_HASH, LIST, {
        handler: (url, method) =>
          method === "POST" && url.pathname === `${P}/identity/clients`
            ? STEP_UP()
            : undefined,
      });
      await title(page, TITLE);
      await page
        .getByRole("button", { name: "Register client" })
        .first()
        .click();
      const drawer = page.getByRole("dialog");
      await drawer.getByRole("textbox", { name: /^Name\b/ }).fill("Forum Two");
      await drawer.getByRole("textbox", { name: /^Key\b/ }).fill("community");
      await drawer
        .getByRole("textbox", { name: /^Redirect addresses/ })
        .fill("https://two.example.com/cb");
      await drawer.getByRole("button", { name: "Register client" }).click();
      await drawer.getByRole("button", { name: "Sign in again" }).waitFor();
      await keepsEntries(page);
      await signInAgain(
        page,
        drawer.getByRole("button", { name: "Sign in again" }),
        LIST_HASH,
      );
      const back = page.getByRole("dialog");
      await back.getByRole("textbox", { name: /^Key\b/ }).waitFor();
      await keepsEntries(page);
      expect(
        await back.getByRole("textbox", { name: /^Key\b/ }).inputValue(),
      ).toBe("community");
      expect(
        await back.getByRole("textbox", { name: /^Name\b/ }).inputValue(),
      ).toBe("Forum Two");
      await closeContext(page.context());
    });

    it("an edit that adds an address asks for a sign-in and keeps the entry", async () => {
      const hash = `${LIST_HASH}/${FORUM.id}`;
      const page = await openForum(hash, (url, method) =>
        method === "PATCH" &&
        url.pathname === `${P}/identity/clients/${FORUM.id}`
          ? STEP_UP()
          : undefined,
      );
      await page.getByRole("button", { name: "Edit" }).first().click();
      const drawer = page.getByRole("dialog");
      const redirects = drawer.getByRole("textbox", {
        name: /^Redirect addresses/,
      });
      await redirects.fill(
        "https://forum.example.com/auth/callback\nhttps://new.example.com/cb",
      );
      await drawer.getByRole("button", { name: "Save" }).click();
      await drawer.getByRole("button", { name: "Sign in again" }).waitFor();
      await drawer
        .getByText(
          "Adding an address or widening access needs a fresh sign-in.",
        )
        .waitFor();
      await keepsEntries(page);
      await signInAgain(
        page,
        drawer.getByRole("button", { name: "Sign in again" }),
        hash,
      );
      const back = page.getByRole("dialog");
      await back
        .getByRole("textbox", { name: /^Redirect addresses/ })
        .waitFor();
      await keepsEntries(page);
      expect(
        await back
          .getByRole("textbox", { name: /^Redirect addresses/ })
          .inputValue(),
      ).toContain("https://new.example.com/cb");
      await closeContext(page.context());
    });

    it("Generate secret and Delete reopen after the sign-in", async () => {
      const hash = `${LIST_HASH}/${FORUM.id}`;
      const page = await openForum(hash, (url, method) =>
        (method === "POST" && url.pathname.endsWith("/secrets")) ||
        (method === "DELETE" &&
          url.pathname === `${P}/identity/clients/${FORUM.id}`)
          ? STEP_UP()
          : undefined,
      );
      await page
        .getByRole("button", { name: "Generate secret" })
        .first()
        .click();
      const dialog = page.getByRole("alertdialog");
      await dialog.getByRole("button", { name: "Generate secret" }).click();
      await signInAgain(
        page,
        dialog.getByRole("button", { name: "Sign in again" }),
        hash,
      );
      await page
        .getByRole("alertdialog")
        .getByText("Generate a secret?")
        .waitFor();
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("button", { name: "More actions" }).first().click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
      const del = page.getByRole("alertdialog");
      await del.getByRole("textbox").fill(FORUM.key);
      await del.getByRole("button", { name: "Delete client" }).click();
      await signInAgain(
        page,
        del.getByRole("button", { name: "Sign in again" }),
        hash,
      );
      const back = page.getByRole("alertdialog");
      await back.getByText(`Delete ${FORUM.name}?`).waitFor();
      expect(await back.getByRole("textbox").inputValue()).toBe(FORUM.key);
      await closeContext(page.context());
    });

    it("a record that fails to load keeps its header", async () => {
      const page = await open(
        "light",
        `${LIST_HASH}/${FORUM.id}`,
        base({ [`${P}/identity/clients`]: page_([FORUM]) }),
        {
          handler: (url) =>
            url.pathname === `${P}/identity/clients/${FORUM.id}`
              ? json(500, { error: { code: "internal" } })
              : undefined,
        },
      );
      await page
        .getByRole("button", { name: /try again|retry/i })
        .first()
        .waitFor({ timeout: 30_000 });
      expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
      await page.getByRole("navigation", { name: /breadcrumb/i }).waitFor();
      await closeContext(page.context());
    });

    it("Rotate now reopens inside Advanced with the slug and reason", async () => {
      const routes = {
        ...base({}),
        "/manage/api/platform/issuer-keys": {
          products: [
            {
              slug: "djdl",
              name: "DJDL",
              issuerOn: true,
              keys: [KEY("a", "active")],
            },
          ],
        },
      };
      const page = await open("light", "#/platform/settings", routes, {
        handler: (url, method) =>
          method === "POST" && url.pathname.endsWith("/rotate")
            ? STEP_UP()
            : undefined,
      });
      await page
        .locator("#platform-advanced")
        .getByRole("button", { name: "Show" })
        .click();
      await page.getByRole("button", { name: "Rotate now" }).first().click();
      const dialog = page.getByRole("alertdialog");
      await dialog
        .getByRole("textbox", { name: /Type the product slug/ })
        .fill("djdl");
      await dialog.getByRole("textbox", { name: "Reason" }).fill("Key leaked");
      await dialog.getByRole("button", { name: "Rotate now" }).click();
      await signInAgain(
        page,
        dialog.getByRole("button", { name: "Sign in again" }),
        "#/platform/settings",
      );
      const back = page.getByRole("alertdialog");
      await back.getByRole("textbox", { name: "Reason" }).waitFor();
      expect(
        await back
          .getByRole("textbox", { name: /Type the product slug/ })
          .inputValue(),
      ).toBe("djdl");
      expect(
        await back.getByRole("textbox", { name: "Reason" }).inputValue(),
      ).toBe("Key leaked");
      await closeContext(page.context());
    });
  });
});
