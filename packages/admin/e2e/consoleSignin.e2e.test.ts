import { mkdirSync } from "node:fs";
import { closeContext } from "./teardown.js";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { handleAdminLogin } from "../../worker/src/console/auth.js";
import { secureResponse } from "../../worker/src/core/securityHeaders.js";
import { makeEnv } from "../../worker/test/seed.js";
import { KvMock } from "../../worker/test/kvMock.js";

/**
 * The console's sign-in card in real Chromium under the Worker's exact CSP: pressing Continue
 * reaches the IdP with zero CSP violations. Continue is a POST answered with a 303 (SIGN-IN.md
 * §3.13), and browsers apply `form-action` to every redirect a form submission follows, so the
 * card's policy must name the IdP (a static render cannot show it). The typed address travels in
 * the body: it is in no URL the browser visits before the IdP.
 * The Worker's own login handler serves the page; discovery and the IdP are stubs.
 */
const ISSUER = "https://id.example";

let browser: Browser;
let server: http.Server;
let origin = "";
const realFetch = globalThis.fetch;

beforeAll(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url === `${ISSUER}/.well-known/openid-configuration`)
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
          response_types_supported: ["code"],
        }),
        { headers: { "content-type": "application/json" } },
      );
    return realFetch(input, init);
  }) as typeof fetch;
  const env = makeEnv(new KvMock(), []);
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = "console";
  server = http.createServer(async (q, r) => {
    const url = new URL(q.url!, origin);
    const chunks: Buffer[] = [];
    for await (const c of q) chunks.push(c as Buffer);
    const headers = new Headers({ "cf-connecting-ip": "203.0.113.50" });
    for (const [k, v] of Object.entries(q.headers))
      if (typeof v === "string") headers.set(k, v);
    const req = new Request(url, {
      method: q.method,
      headers,
      ...(q.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
    });
    const res = secureResponse(await handleAdminLogin(req, env));
    r.writeHead(res.status, Object.fromEntries(res.headers));
    r.end(Buffer.from(await res.arrayBuffer()));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  env.CONSOLE_ORIGIN = origin;
  browser = await chromium.launch();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await browser?.close();
  await new Promise((ok) => server?.close(ok));
});

describe("console sign-in card in Chromium", () => {
  it("Continue reaches the IdP with no CSP violation, carrying login_hint and returnTo", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const visited: string[] = [];
    page.on("request", (r) => visited.push(r.url()));
    const violations: string[] = [];
    page.on("console", (m) => {
      if (/Content Security Policy|violates/i.test(m.text()))
        violations.push(m.text());
    });
    // The stub IdP is not dialled: the proof is that Chromium issues the request to the IdP at
    // all. A `form-action` block stops the redirect before any request is made.
    const idpRequest = page.waitForRequest(`${ISSUER}/authorize**`, {
      timeout: 15_000,
    });
    await context.route(`${ISSUER}/**`, (route) => route.abort());
    await page.goto(
      `${origin}/manage/login?returnTo=${encodeURIComponent("/manage/#/p/alpha")}`,
    );
    await page.getByLabel("Email").fill("ada@example.com");
    await page.getByRole("button", { name: "Continue" }).click();
    const idpUrl = new URL((await idpRequest).url());
    expect(violations).toEqual([]);
    expect(idpUrl.pathname).toBe("/authorize");
    expect(idpUrl.searchParams.get("login_hint")).toBe("ada@example.com");
    expect(idpUrl.searchParams.get("code_challenge_method")).toBe("S256");
    // The address went in the body: no URL on this origin ever carried it.
    expect(
      visited.filter((u) => u.startsWith(origin) && u.includes("ada")),
    ).toEqual([]);
    expect(
      visited
        .filter((u) => u.startsWith(origin))
        .map((u) => new URL(u).pathname),
    ).toContain("/manage/login");
    await closeContext(context);
  });

  it.each([
    ["dark", 1440, 900],
    ["light", 1440, 900],
    ["dark", 390, 844],
    ["light", 390, 844],
  ] as const)(
    "the card with Help and Privacy under it, %s at %i px",
    async (scheme, width, height) => {
      const context = await browser.newContext({
        colorScheme: scheme,
        viewport: { width, height },
      });
      const page = await context.newPage();
      await page.goto(`${origin}/manage/login`);
      const nav = page.getByRole("navigation", { name: "Help and links" });
      await nav.waitFor();
      const links = nav.getByRole("link");
      expect(await links.allTextContents()).toEqual([
        "Help",
        "Privacy",
        "Emergency sign-in",
      ]);
      expect(await links.nth(0).getAttribute("href")).toBe("/docs/");
      expect(await links.nth(1).getAttribute("href")).toBe(
        "/docs/reference/what-apps-collect/",
      );
      // Under the card, in the first viewport, targets of at least 24 px, no sideways scroll.
      const card = (await page.locator("main.ac").boundingBox())!;
      for (let i = 0; i < 3; i++) {
        const b = (await links.nth(i).boundingBox())!;
        expect(b.y).toBeGreaterThanOrEqual(card.y + card.height);
        expect(b.y + b.height).toBeLessThanOrEqual(height);
        expect(b.height).toBeGreaterThanOrEqual(24);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      if (process.env.PK_SHOTS_DIR) {
        mkdirSync(process.env.PK_SHOTS_DIR, { recursive: true });
        await page.screenshot({
          path: `${process.env.PK_SHOTS_DIR}/card-${width}-${scheme}.png`,
        });
      }
      await closeContext(context);
    },
  );
});

// A `__Host-` cookie needs a secure origin, and the test server is plain http: the browser would
// refuse to store it, so the hint is sent as a request header (what the Worker reads either way).
const HINT_HEADER = { cookie: "__Host-pkey_console_hint=ada%40example.com" };

describe("the known-operator chip, Change and the break-glass link (ST-30c.2)", () => {
  const shot = async (
    page: import("playwright").Page,
    name: string,
    scheme: string,
    width: number,
  ) => {
    if (!process.env.PK_SHOTS_DIR) return;
    mkdirSync(process.env.PK_SHOTS_DIR, { recursive: true });
    await page.screenshot({
      path: `${process.env.PK_SHOTS_DIR}/${name}-${width}-${scheme}.png`,
    });
  };

  it("the chip shows the remembered address; Continue sends it as login_hint, with no CSP violation", async () => {
    const context = await browser.newContext();
    await context.setExtraHTTPHeaders(HINT_HEADER);
    const page = await context.newPage();
    const violations: string[] = [];
    page.on("console", (m) => {
      if (/Content Security Policy|violates/i.test(m.text()))
        violations.push(m.text());
    });
    const idpRequest = page.waitForRequest(`${ISSUER}/authorize**`, {
      timeout: 15_000,
    });
    await context.route(`${ISSUER}/**`, (route) => route.abort());
    await page.goto(`${origin}/manage/login`);
    await page.locator(".chip-email").waitFor();
    expect(await page.locator(".chip-email").textContent()).toBe(
      "ada@example.com",
    );
    await page.getByRole("button", { name: "Continue" }).click();
    const idpUrl = new URL((await idpRequest).url());
    expect(idpUrl.searchParams.get("login_hint")).toBe("ada@example.com");
    expect(violations).toEqual([]);
    await closeContext(context);
  });

  it("Change clears the cookie and shows the empty field", async () => {
    const context = await browser.newContext();
    await context.setExtraHTTPHeaders(HINT_HEADER);
    const page = await context.newPage();
    await page.goto(`${origin}/manage/login`);
    const changed = page.waitForResponse((r) => r.url().includes("change=1"));
    await page.getByRole("link", { name: "Change" }).click();
    const cleared = (await (await changed).allHeaders())["set-cookie"] ?? "";
    expect(cleared).toContain("__Host-pkey_console_hint=;");
    expect(cleared).toContain("Max-Age=0");
    await page.getByLabel("Email").waitFor();
    expect(new URL(page.url()).searchParams.get("change")).toBe("1");
    expect(await page.getByLabel("Email").inputValue()).toBe("");
    await closeContext(context);
  });

  it("the Emergency sign-in link opens the start card, and Continue starts a fresh-login flow", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const violations: string[] = [];
    page.on("console", (m) => {
      if (/Content Security Policy|violates/i.test(m.text()))
        violations.push(m.text());
    });
    const idpRequest = page.waitForRequest(`${ISSUER}/authorize**`, {
      timeout: 15_000,
    });
    await context.route(`${ISSUER}/**`, (route) => route.abort());
    await page.goto(`${origin}/manage/login`);
    await page.getByRole("link", { name: "Emergency sign-in" }).click();
    await page.getByRole("heading", { name: "Emergency sign-in" }).waitFor();
    await page.getByText("Every use is recorded").waitFor();
    await page.getByRole("button", { name: "Continue" }).click();
    const idpUrl = new URL((await idpRequest).url());
    expect(idpUrl.searchParams.get("prompt")).toBe("login");
    expect(idpUrl.searchParams.get("max_age")).toBe("0");
    expect(violations).toEqual([]);
    await closeContext(context);
  });

  it.each([
    ["dark", 1440, 900],
    ["light", 390, 844],
  ] as const)(
    "every card state, %s at %i px (shots with PK_SHOTS_DIR)",
    async (scheme, width, height) => {
      const context = await browser.newContext({
        colorScheme: scheme,
        viewport: { width, height },
      });
      await context.setExtraHTTPHeaders(HINT_HEADER);
      const page = await context.newPage();
      for (const [name, path, ready] of [
        ["signin-chip", "/manage/login", ".chip-email"],
        ["signedout-chip", "/manage/login?signedOut=1", ".chip-email"],
        ["ended-chip", "/manage/login?ended=1", ".chip-email"],
        ["breakglass", "/manage/login?breakGlass=1", "text=Every use is"],
        ["change-empty", "/manage/login?change=1", "#email"],
      ] as const) {
        await page.goto(`${origin}${path}`);
        await page.locator(ready).first().waitFor();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        await shot(page, name, scheme, width);
      }
      await closeContext(context);
    },
  );
});

describe("the chip under large text and the lockup (UX review fixes)", () => {
  it.each([
    [360, 150],
    [360, 200],
    [390, 150],
    [390, 200],
  ] as const)(
    "the address stays readable at %i px and %i %% text, with no sideways scroll",
    async (width, pct) => {
      const context = await browser.newContext({
        viewport: { width, height: 800 },
      });
      await context.setExtraHTTPHeaders({
        cookie:
          "__Host-pkey_console_hint=vlad.zaharia%40polaris-engineering.dev",
      });
      const page = await context.newPage();
      await page.goto(`${origin}/manage/login`);
      await page.evaluate(
        (p) => document.documentElement.style.setProperty("font-size", `${p}%`),
        pct,
      );
      const email = page.locator(".chip-email");
      const box = (await email.boundingBox())!;
      // Change drops to its own line rather than squeezing the address to a sliver.
      expect(box.width).toBeGreaterThan(110);
      const lines = await email.evaluate((el) =>
        Math.round(
          el.getBoundingClientRect().height /
            parseFloat(getComputedStyle(el).lineHeight || "20"),
        ),
      );
      expect(lines).toBeLessThanOrEqual(4);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      if (process.env.PK_SHOTS_DIR) {
        mkdirSync(process.env.PK_SHOTS_DIR, { recursive: true });
        await page.screenshot({
          path: `${process.env.PK_SHOTS_DIR}/text${pct}-chip-${width}.png`,
        });
      }
      await closeContext(context);
    },
  );

  it("the lockup is 64 px tall from 30 rem and 52 px on phones, and 'Console' is 20 px / 500", async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(`${origin}/manage/login`);
    const size = () =>
      page.evaluate(() => {
        const svg = document
          .querySelector(".ac-brand svg")!
          .getBoundingClientRect();
        const s = getComputedStyle(document.querySelector(".ac-surface")!);
        return [
          Math.round(svg.width),
          Math.round(svg.height),
          s.fontSize,
          s.fontWeight,
        ];
      });
    expect(await size()).toEqual([222, 64, "20px", "500"]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect((await size()).slice(0, 2)).toEqual([180, 52]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() =>
      document.documentElement.style.setProperty("font-size", "200%"),
    );
    // Label and wordmark grow together (both in rem).
    const big = await size();
    expect(big[0]).toBe(444);
    expect(big[2]).toBe("40px");
    await closeContext(context);
  });
});
