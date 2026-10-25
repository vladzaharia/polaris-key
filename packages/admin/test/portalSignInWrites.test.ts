import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { setPortalCsrf } from "../src/portal/api.js";
import { bindWriteInvalidation, mutate } from "../src/portal/mutations.js";
import { pq } from "../src/portal/queries.js";

/**
 * The sign-in writes now go through `mutate` (P0-32.6). What must not move: each is sent once, in
 * the order the card makes them; no cache entry ever holds a code or a key; the requests carry the
 * same credentials as before (the binder cookie rides on same-origin credentials, never a header).
 */

interface Sent {
  method: string;
  path: string;
  body: string | null;
  headers: string[];
  credentials: RequestCredentials | undefined;
}

let sent: Sent[];
let client: QueryClient;
let unbind: () => void;

beforeEach(() => {
  setPortalCsrf("tok");
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit = {}) => {
      sent.push({
        method: init.method ?? "GET",
        path,
        body: typeof init.body === "string" ? init.body : null,
        headers: [...new Headers(init.headers).keys()].sort(),
        credentials: init.credentials,
      });
      return new Response('{"status":"signed_in","options":{}}', {
        status: 200,
      });
    }),
  );
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  unbind = bindWriteInvalidation(client);
});
afterEach(() => {
  unbind();
  vi.unstubAllGlobals();
  setPortalCsrf("");
});

describe("sign-in writes keep their wire behaviour", () => {
  it("email code: start, resend and verify are each sent once, in order", async () => {
    await mutate("startEmailSignIn", "a@example.com");
    await mutate("resendSignInCode");
    await mutate("verifySignInCode", "424242");
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      "POST /api/signin/email/start",
      "POST /api/signin/email/resend",
      "POST /api/signin/email/verify",
    ]);
  });

  it("passkey: options then verify, once each, in order", async () => {
    await mutate("passkeySignInOptions", "/");
    await mutate("passkeySignInVerify", { id: "cred" } as never);
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      "POST /api/signin/passkey/options",
      "POST /api/signin/passkey/verify",
    ]);
  });

  it("device login: start, lookup and decide, once each, in order", async () => {
    await mutate("deviceLoginStart");
    await mutate("deviceLoginLookup", "ABCD-EFGH");
    await mutate("deviceLoginDecide", "ABCD-EFGH", "approve");
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      "POST /api/device-login/start",
      "POST /api/device-login/lookup",
      "POST /api/device-login/approve",
    ]);
  });

  it("request card: continue and cancel, once each; sign-out is a POST /logout with no CSRF", async () => {
    await mutate("signinContinue", "h1", {});
    await mutate("signinCancel", "h1");
    sent.length = 0;
    await mutate("signOutHere");
    const logout = sent.filter((s) => s.path === "/logout");
    expect(logout).toHaveLength(1);
    expect(logout[0]!.headers).not.toContain("x-pkey-portal-csrf");
  });

  it("no extra write rides along: what the table refetches afterwards is only reads", async () => {
    const unsub = new QueryObserver(client, pq.me()).subscribe(() => undefined);
    await vi.waitFor(() =>
      expect(client.getQueryState(pq.me().queryKey)?.status).toBe("success"),
    );
    sent.length = 0;
    await mutate("signOutHere");
    const refetches = sent.filter((s) => s.path !== "/logout");
    expect(refetches.length).toBeGreaterThan(0);
    for (const s of refetches) expect(s.method, s.path).toBe("GET");
    unsub();
  });

  it("every write carries the same-origin credentials and only the portal's headers", async () => {
    await mutate("startEmailSignIn", "a@example.com");
    await mutate("verifySignInCode", "424242");
    await mutate("passkeySignInVerify", { id: "c" } as never);
    await mutate("deviceLoginDecide", "ABCD-EFGH", "approve");
    await mutate("signinContinue", "h1", {});
    for (const s of sent) {
      expect(s.credentials, s.path).toBe("same-origin");
      // The binder cookie is the browser's; nothing here sets a Cookie or Authorization header.
      expect(s.headers, s.path).toEqual(["content-type", "x-pkey-portal-csrf"]);
    }
  });
});

describe("no cache entry holds a code or a key", () => {
  it("after the sign-in writes the query and mutation caches contain neither", async () => {
    const code = "909090";
    const key = "pkey_SECRETSECRETSECRET";
    await mutate("verifySignInCode", code);
    await mutate("previewKeySignedOut", key);
    await mutate("startEmailSignIn", "someone@example.com");
    await mutate("deviceLoginLookup", "WXYZ-1234");
    const dump = JSON.stringify([
      client
        .getQueryCache()
        .getAll()
        .map((q) => [q.queryKey, q.state.data]),
      client
        .getMutationCache()
        .getAll()
        .map((m) => [m.options.mutationKey, m.state.variables]),
    ]);
    for (const secret of [code, key, "WXYZ-1234"])
      expect(dump).not.toContain(secret);
  });
});
