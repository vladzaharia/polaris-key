// Test isolation for isolate-level state.
//
//   - Every module cache registers its clear with `src/platform/testReset.ts`; each test starts
//     by running them all, so a file sees what a fresh Worker isolate would even when the runner
//     shares one module graph across files (the `shared` project, vitest.isolation.ts). The files
//     that mock a module run in the `isolated` project, one fresh graph each.
//   - The relying-party client (I-30) caches discovery documents and key sets; tests install a
//     fresh IdP key per case.
//   - It discovers the issuer before every authorization request. A test that only STARTS a
//     sign-in has no IdP of its own, so the default `fetch` answers any issuer's discovery
//     document (Pocket ID's shape, `test/oidcIssuerFake.ts`) and passes every other URL on. A test
//     that completes a sign-in installs its own `fetch` for the token endpoint and the JWKS, which
//     replaces this default for that test.
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import { issuerDiscovery } from "../oidcIssuerFake.js";

const DISCOVERY = "/.well-known/openid-configuration";
// In the `shared` project this file runs once per test file in one global scope: keep the first
// (real) `fetch`, never an earlier file's stub or this file's own wrapper.
const REAL_FETCH = Symbol.for("pkey.test.realFetch");
const scope = globalThis as unknown as Record<symbol, typeof fetch>;
const realFetch = (scope[REAL_FETCH] ??= globalThis.fetch);

// Isolate-level state is emptied at the file boundary, before the file's own `beforeAll` (a file
// installs its test doubles there) and after it. What a file stubs, it gives back.
async function emptyIsolate(): Promise<void> {
  (await import("../../src/platform/testReset.js")).runResets();
}

beforeAll(emptyIsolate);

afterAll(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await emptyIsolate();
});

beforeEach(async () => {
  // The relying-party client's caches are emptied per test: each test installs its own IdP key.
  (await import("../../src/core/oidc/client.js")).resetOidcClientCaches();
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
