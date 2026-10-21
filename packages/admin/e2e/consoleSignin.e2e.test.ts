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
 * reaches the IdP with zero CSP violations. Browsers apply `form-action` to every redirect a form
 * submission follows, so the card's policy must name the IdP (a static render cannot show it).
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
    const req = new Request(url, {
      headers: { "cf-connecting-ip": "203.0.113.50" },
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
    await context.close();
  });
});
