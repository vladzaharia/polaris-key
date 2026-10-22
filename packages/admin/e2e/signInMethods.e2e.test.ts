/**
 * The operator's Sign-in methods (`#/account/sign-in-methods`, ST-30c.4) in real Chromium under the
 * Worker's CSP, every state at 1440 dark and 390 light: no CSP violation, no sideways scroll, the
 * dialogs inside the window. A virtual authenticator runs a real `navigator.credentials.create()`
 * against a registration challenge shaped like I-16's, and the rows are measured at 200 % text.
 * With PK_SHOTS_DIR set it saves each state.
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
interface Method {
  id: string;
  kind: string;
  name: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  strong: boolean;
  consoleEligible: boolean;
  aaguid: string | null;
  addedFrom: string | null;
}
const method = (over: Partial<Method>): Method => ({
  id: "m",
  kind: "oidc",
  name: null,
  createdAt: NOW - 90 * 86400,
  lastUsedAt: NOW - 3600,
  strong: true,
  consoleEligible: false,
  aaguid: null,
  addedFrom: null,
  ...over,
});
const OIDC = method({ id: "lnk_oidc" });
const LOCKER_PK = method({
  id: "lnk_pk",
  kind: "passkey",
  aaguid: "fbfc3007-154e-4ecc-8c0b-6e020557d7bd",
  addedFrom: "Safari on macOS",
  createdAt: NOW - 30 * 86400,
  lastUsedAt: null,
  strong: false,
  consoleEligible: true,
});
const MANY = [
  OIDC,
  LOCKER_PK,
  ...["google", "apple", "steam", "gamecenter", "pgs"].map((kind, i) =>
    method({
      id: `lnk_${kind}`,
      kind,
      strong: false,
      createdAt: NOW - i * 86400,
    }),
  ),
  method({
    id: "lnk_pk2",
    kind: "passkey",
    name: "A deliberately long passkey name for the YubiKey in the Tidewater office",
    strong: false,
    consoleEligible: true,
    lastUsedAt: null,
  }),
];

type Body = unknown | { status: number; json: unknown };
interface Scenario {
  methods?: Method[];
  list?: Body;
  addable?: { canAdd: boolean; reason: string | null };
  options?: Body;
  strong?: Body;
  me?: Record<string, unknown>;
  /** Make `navigator.credentials.create` reject with this DOMException name. */
  browser?: "NotAllowedError";
  /** Run `create()` for real, against a CDP virtual authenticator. */
  virtual?: boolean;
  /** A root font size, as a percentage. */
  text?: number;
}

/** I-16's registration challenge: `rp` and `pubKeyCredParams` are what a real `create()` needs. */
const CHALLENGE = {
  options: {
    challenge: "Y2hhbGxlbmdlLWNoYWxsZW5nZQ",
    rp: { name: "Polaris Key" },
    user: { id: "dXNlci1hZGE", name: "ada@example.com", displayName: "Ada" },
    pubKeyCredParams: [
      { type: "public-key", alg: -8 },
      { type: "public-key", alg: -7 },
    ],
    timeout: 60000,
    attestation: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "preferred",
    },
    excludeCredentials: [],
  },
  expiresIn: 300,
};

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
  views: readonly { w: number; h: number; theme: "dark" | "light" }[] = VIEWS,
): Promise<void> {
  await Promise.all(
    views.map(async (v) => {
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
      const state = { methods: [...(sc.methods ?? [OIDC, LOCKER_PK])] };
      await ctx.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        const p = url.pathname;
        const post = route.request().method() === "POST";
        if (p.startsWith("/manage/api/")) {
          if (p === "/manage/api/me")
            return route.fulfill({ json: { ...ME, ...sc.me } });
          if (p === "/manage/api/products")
            return route.fulfill({ json: { products: [] } });
          if (p === "/manage/api/attention")
            return route.fulfill({ json: { items: [] } });
          if (p === "/manage/api/me/methods")
            return route.fulfill(
              reply(
                sc.list ?? {
                  methods: state.methods,
                  ...(sc.addable ?? { canAdd: true, reason: null }),
                },
              ),
            );
          if (p === "/manage/api/me/passkeys/options")
            return route.fulfill(reply(sc.options ?? CHALLENGE));
          if (p === "/manage/api/me/passkeys" && post) {
            const id = `lnk_new${state.methods.length}`;
            state.methods = [
              ...state.methods,
              method({
                id,
                kind: "passkey",
                addedFrom: "Chrome on macOS",
                createdAt: NOW,
                lastUsedAt: null,
              }),
            ];
            return route.fulfill({
              status: 201,
              json: { ok: true, passkey: { id: "cred", methodId: id } },
            });
          }
          if (p === "/manage/api/me/methods/lnk_pk/strong")
            return route.fulfill(reply(sc.strong ?? { ok: true }));
          return route.fulfill({ status: 404, json: { error: "not_found" } });
        }
        const res = await route.fetch();
        const headers = { ...res.headers() };
        if (p.endsWith(".html")) headers["content-security-policy"] = CSP;
        return route.fulfill({ response: res, headers });
      });
      const page = await ctx.newPage();
      try {
        if (sc.virtual) {
          const cdp = await ctx.newCDPSession(page);
          await cdp.send("WebAuthn.enable", { enableUI: false });
          await cdp.send("WebAuthn.addVirtualAuthenticator", {
            options: {
              protocol: "ctap2",
              transport: "internal",
              hasResidentKey: true,
              hasUserVerification: true,
              isUserVerified: true,
              automaticPresenceSimulation: true,
            },
          });
        }
        // A hostname, not an IP: WebAuthn refuses an IP address as the relying-party id.
        await page.goto(
          `${base.replace("127.0.0.1", "localhost")}/manage.html#/account/sign-in-methods`,
        );
        await page
          .getByRole("heading", { level: 1, name: "Sign-in methods" })
          .waitFor();
        // The house's "text scales with the root font": the root size, as a percentage.
        if (sc.text)
          await page.evaluate((pct) => {
            document.documentElement.style.fontSize = `${pct}%`;
          }, sc.text);
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
  page.getByRole("region", { name: "Opens the console" }).waitFor();
const openAdd = async (page: Page) => {
  await page.getByRole("button", { name: "Add a passkey" }).first().click();
  await page.getByRole("alertdialog").waitFor();
};
const openUse = async (page: Page) => {
  await page.getByRole("button", { name: /^Use .* for the console/ }).click();
  await page.getByRole("alertdialog").waitFor();
};
const confirm = (page: Page, name: string) =>
  page.getByRole("alertdialog").getByRole("button", { name }).click();

describe.concurrent("Sign-in methods", () => {
  it("list", () => run("list", {}, listed));
  it("list: every kind", () => run("list-many", { methods: MANY }, listed));
  it("empty", () =>
    run("empty", { methods: [] }, (p) =>
      p.getByText("No sign-in methods").waitFor(),
    ));
  it("loading failed", () =>
    run("error", { list: { status: 500, json: { error: "boom" } } }, (p) =>
      p.getByRole("button", { name: /Try again/ }).waitFor(),
    ));
  it("add: confirm", () =>
    run("add-confirm", {}, async (p) => {
      await listed(p);
      await openAdd(p);
    }));
  it("add: Add a passkey is off, with its reason", () =>
    run(
      "add-off-limit",
      { addable: { canAdd: false, reason: "limit" } },
      async (p) => {
        await listed(p);
        await p
          .getByText(/Remove one in Polaris Locker/)
          .first()
          .waitFor();
      },
    ));
  it("add: a real create() against a virtual authenticator", () =>
    run("add-virtual", { virtual: true }, async (p) => {
      await listed(p);
      await openAdd(p);
      await confirm(p, "Add passkey");
      await p.getByRole("alertdialog").waitFor({ state: "detached" });
      // The new row has focus, with a visible ring.
      await p
        .locator("[data-method-id^='lnk_new']")
        .waitFor({ state: "visible" });
      await p.waitForFunction(() =>
        (
          document.activeElement as HTMLElement | null
        )?.dataset.methodId?.startsWith("lnk_new"),
      );
      const ring = await p.evaluate(() => {
        const s = getComputedStyle(document.activeElement as HTMLElement);
        return { style: s.outlineStyle, width: s.outlineWidth };
      });
      expect(ring.style).not.toBe("none");
      expect(parseFloat(ring.width)).toBeGreaterThan(0);
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
        options: {
          status: 403,
          json: { error: { code: "step_up_required" } },
        },
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
        await p
          .getByRole("alertdialog")
          .getByRole("button", { name: "Add a passkey" })
          .waitFor();
      },
    ));
  it("break-glass", () =>
    run("emergency", { me: { breakGlass: true } }, (p) =>
      p.getByText("Emergency sign-in can't manage sign-in methods").waitFor(),
    ));
  it("200 % text: the name keeps its width at every window", async () => {
    for (const w of [1440, 1280, 768, 390]) {
      await run(
        `text200-${w}`,
        { methods: MANY, text: 200 },
        async (p) => {
          await listed(p);
          const narrowest = await p.evaluate(() =>
            Math.min(
              ...[
                ...document.querySelectorAll("[data-method-id] .basis-60"),
              ].map((e) => e.getBoundingClientRect().width),
            ),
          );
          // A real basis, not a column squeezed to a letter.
          expect(narrowest).toBeGreaterThanOrEqual(Math.min(w - 64, 150));
        },
        [{ w, h: 900, theme: "light" as const }],
      );
    }
  });
});
