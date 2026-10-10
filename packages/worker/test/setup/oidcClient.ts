// I-30: test isolation for the one relying-party client (`src/core/oidc/client.ts`).
//
//   - It caches discovery documents and key sets per isolate; tests install a fresh IdP key per
//     case, so every test starts with empty caches, as a fresh Worker isolate would.
//   - It discovers the issuer before every authorization request. A test that only STARTS a
//     sign-in has no IdP of its own, so the default `fetch` answers any issuer's discovery
//     document (Pocket ID's shape, `test/oidcIssuerFake.ts`) and passes every other URL on. A test
//     that completes a sign-in installs its own `fetch` for the token endpoint and the JWKS, which
//     replaces this default for that test.
import { beforeEach } from "vitest";
import { resetOidcClientCaches } from "../../src/core/oidc/client.js";
import { issuerDiscovery } from "../oidcIssuerFake.js";

const DISCOVERY = "/.well-known/openid-configuration";
const realFetch = globalThis.fetch;

beforeEach(() => {
  resetOidcClientCaches();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.endsWith(DISCOVERY)) {
      return new Response(
        JSON.stringify(issuerDiscovery(url.slice(0, -DISCOVERY.length))),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
