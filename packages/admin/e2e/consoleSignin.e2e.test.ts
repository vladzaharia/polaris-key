import { mkdirSync } from "node:fs";
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
    await context.close();
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
      const nav = page.getByRole("navigation", { name: "Help and privacy" });
      await nav.waitFor();
      const links = nav.getByRole("link");
      expect(await links.allTextContents()).toEqual(["Help", "Privacy"]);
      expect(await links.nth(0).getAttribute("href")).toBe("/docs/");
      expect(await links.nth(1).getAttribute("href")).toBe(
        "/docs/reference/what-apps-collect/",
      );
      // Under the card, in the first viewport, targets of at least 24 px, no sideways scroll.
      const card = (await page.locator("main.ac").boundingBox())!;
      for (let i = 0; i < 2; i++) {
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
      await context.close();
    },
  );
});
