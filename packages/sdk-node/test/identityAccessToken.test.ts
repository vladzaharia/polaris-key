// @pkey-feature identity.accesstoken
// `identity.accessToken()` (I-21b, WIRE-CONTRACT-V5 §12.13.10): the device exchange, its cache
// rule (memory, reuse until 60 s before expiry, one request at a time, dropped at sign-out) and
// the typed answers when it cannot be had. The recorded conversation is `identity-access-token`,
// replayed in conformance/runners/node.

import { afterEach, describe, expect, it, vi } from "vitest";
import { PolarisError, UnsupportedError } from "@polaris-key/client-core";
import {
  identityDiscovery,
  json,
  seededClient,
  type Handler,
  type Seen,
} from "./parityFixtures.js";

const TOKEN_URL = "/djdl/identity/token";
const JWT = "aaa.bbb.ccc";
const extra = { expectedServices: ["license", "config", "identity"] as never };
const named = {
  issuer: "https://k.test/djdl/identity",
  accessToken: true,
  endpoints: {
    token: `https://k.test${TOKEN_URL}`,
    signout: "https://k.test/djdl/identity/signout",
  },
};
const answer = (over: Record<string, unknown> = {}): Response =>
  json(
    {
      access_token: JWT,
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      token_type: "Bearer",
      expires_in: 600,
      scope: "",
      ...over,
    },
    200,
    { "cache-control": "no-store" },
  );

async function clientWith(
  exchange: Handler,
  fragment: Record<string, unknown> | null = named,
  token: string | null = "pkeyt_dev",
) {
  return seededClient({
    token,
    extra,
    routes: {
      "GET /djdl/.well-known/polaris.json": identityDiscovery(fragment),
      [`POST ${TOKEN_URL}`]: exchange,
      "POST /djdl/identity/signout": () => json({ released: false }),
    },
  });
}

const exchanges = (seen: Seen[]) =>
  seen.filter((r) => r.method === "POST" && r.path === TOKEN_URL);

afterEach(() => vi.useRealTimers());

const tokensOf = (client: unknown) =>
  (client as { tokens: { set(t: string, s: string): Promise<void> } }).tokens;

describe("identity.accessToken()", () => {
  it("trades the device token for a 600 second access token, with no Authorization header", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 });
    const { client, seen } = await clientWith(() => answer());
    const got = await client.identity.accessToken();
    expect(got).toEqual({
      accessToken: JWT,
      tokenType: "Bearer",
      expiresIn: 600,
      expiresAt: 1_700_000_600,
    });
    const [req] = exchanges(seen);
    expect(req!.headers.get("authorization")).toBeNull();
    expect(req!.headers.get("x-pkey-device")).toBeTruthy();
    expect(req!.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    const form = new URLSearchParams(req!.body ?? "");
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      client_id: "djdl",
      subject_token: "pkeyt_dev",
      subject_token_type: "urn:polaris-key:token-type:device",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    });
  });

  it("reuses the token until 60 seconds before it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 });
    const { client, seen } = await clientWith(() => answer());
    await client.identity.accessToken();
    vi.setSystemTime(1_700_000_000_000 + 539_000);
    const again = await client.identity.accessToken();
    expect(again.expiresIn).toBe(61);
    expect(exchanges(seen)).toHaveLength(1);
    vi.setSystemTime(1_700_000_000_000 + 540_000);
    await client.identity.accessToken();
    expect(exchanges(seen)).toHaveLength(2);
  });

  it("asks once for callers that arrive together, and again on refresh", async () => {
    const { client, seen } = await clientWith(() => answer());
    await Promise.all([
      client.identity.accessToken(),
      client.identity.accessToken(),
      client.identity.accessToken(),
    ]);
    expect(exchanges(seen)).toHaveLength(1);
    await client.identity.accessToken({ refresh: true });
    expect(exchanges(seen)).toHaveLength(2);
  });

  it("drops the token at sign-out", async () => {
    const { client, seen } = await clientWith(() => answer());
    await client.identity.accessToken();
    await client.identity.signOut();
    // Signed out: the device token is still the key-activation one, so the exchange is asked again.
    await client.identity.accessToken();
    expect(exchanges(seen)).toHaveLength(2);
  });

  it.each([
    [
      "discovery names no accessToken",
      { issuer: "https://k.test/djdl/identity", endpoints: named.endpoints },
    ],
    [
      "the exchange endpoint is outside the client's own origin",
      {
        ...named,
        endpoints: {
          ...named.endpoints,
          token: "https://elsewhere.test/djdl/identity/token",
        },
      },
    ],
  ])(
    "is the typed service-unavailable, with no exchange, when %s",
    async (_n, fragment) => {
      const { client, seen } = await clientWith(() => answer(), fragment);
      const err = await client.identity.accessToken().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnsupportedError);
      expect((err as UnsupportedError).code).toBe("service-unavailable");
      expect(exchanges(seen)).toHaveLength(0);
    },
  );

  it("is service-unavailable too while Identity is off", async () => {
    const { client, seen } = await clientWith(() => answer(), null);
    const err = await client.identity.accessToken().catch((e: unknown) => e);
    expect((err as PolarisError).code).toBe("service-unavailable");
    expect(exchanges(seen)).toHaveLength(0);
  });

  it("needs a device token: no-token, nothing sent", async () => {
    const { client, seen } = await clientWith(() => answer(), named, null);
    const err = await client.identity.accessToken().catch((e: unknown) => e);
    expect((err as PolarisError).code).toBe("no-token");
    expect(exchanges(seen)).toHaveLength(0);
  });

  it("raises the Worker's refusals under its own codes", async () => {
    const grant = await clientWith(() => json({ error: "invalid_grant" }, 400));
    const g = (await grant.client.identity
      .accessToken()
      .catch((e: unknown) => e)) as PolarisError;
    expect([g.code, g.status]).toEqual(["invalid_grant", 400]);

    const off = await clientWith(() =>
      json(
        {
          error: "invalid_request",
          error_description: "subject_token_type is not supported.",
        },
        400,
      ),
    );
    const o = (await off.client.identity
      .accessToken()
      .catch((e: unknown) => e)) as PolarisError;
    expect([o.code, o.status]).toEqual(["invalid_request", 400]);
  });

  it("reports a 429 with the wait the answer carries, then fails fast until it has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 });
    let n = 0;
    const { client, seen } = await clientWith(() =>
      n++ === 0
        ? json({ error: "rate_limited", retryAfter: 60 }, 429)
        : answer(),
    );
    const err = (await client.identity
      .accessToken()
      .catch((e: unknown) => e)) as PolarisError;
    expect([err.code, err.status, err.retryAfterSeconds]).toEqual([
      "rate_limited",
      429,
      60,
    ]);
    vi.setSystemTime(1_700_000_000_000 + 20_000);
    for (const opts of [{}, { refresh: true }]) {
      const again = (await client.identity
        .accessToken(opts)
        .catch((e: unknown) => e)) as PolarisError;
      expect([again.code, again.retryAfterSeconds]).toEqual([
        "rate_limited",
        40,
      ]);
    }
    expect(exchanges(seen)).toHaveLength(1);
    vi.setSystemTime(1_700_000_000_000 + 60_000);
    await client.identity.accessToken();
    expect(exchanges(seen)).toHaveLength(2);
  });

  it("asks again for a replaced device token or another account's sign-in", async () => {
    const { client, seen } = await clientWith((req) =>
      answer({
        access_token: `${new URLSearchParams(req.body ?? "").get("subject_token")}.b.c`,
      }),
    );
    const tokens = tokensOf(client);
    expect((await client.identity.accessToken()).accessToken).toBe(
      "pkeyt_dev.b.c",
    );
    await tokens.set("pkeyt_other", "license");
    expect((await client.identity.accessToken()).accessToken).toBe(
      "pkeyt_other.b.c",
    );
    await tokens.set("pkeyt_acct_b", "signin");
    expect((await client.identity.accessToken()).accessToken).toBe(
      "pkeyt_acct_b.b.c",
    );
    expect(exchanges(seen)).toHaveLength(3);
  });

  it("does not hand an exchange begun under the old token to a caller with the new one", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { client, seen } = await clientWith(async (req) => {
      const sub = new URLSearchParams(req.body ?? "").get("subject_token");
      if (sub === "pkeyt_dev") await gate;
      return answer({ access_token: `${sub}.b.c` });
    });
    const tokens = tokensOf(client);
    const old = client.identity.accessToken();
    await vi.waitFor(() => expect(exchanges(seen)).toHaveLength(1));
    await tokens.set("pkeyt_new", "signin");
    const fresh = await client.identity.accessToken();
    expect(fresh.accessToken).toBe("pkeyt_new.b.c");
    release();
    expect((await old).accessToken).toBe("pkeyt_dev.b.c");
    expect((await client.identity.accessToken()).accessToken).toBe(
      "pkeyt_new.b.c",
    );
    expect(exchanges(seen)).toHaveLength(2);
  });

  it("never follows a redirect with the device token in the body", async () => {
    const redirects: unknown[] = [];
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/identity/token")) {
        redirects.push(init?.redirect);
        // What fetch does for `redirect: "error"` when the server answers a 307.
        throw new TypeError("redirect mode is set to error");
      }
      return url.endsWith("polaris.json")
        ? identityDiscovery(named)({} as never)
        : new Response("", { status: 404 });
    }) as typeof fetch;
    const { client } = await seededClient({
      extra: { ...extra, fetchImpl },
    });
    const err = (await client.identity
      .accessToken()
      .catch((e: unknown) => e)) as PolarisError;
    expect(err.code).toBe("network-error");
    expect(redirects).toEqual(["error"]);
  });

  it("answers bad_response for an access token over 8 KiB", async () => {
    const { client } = await clientWith(() =>
      answer({ access_token: `a.b.${"c".repeat(8192)}` }),
    );
    const err = (await client.identity
      .accessToken()
      .catch((e: unknown) => e)) as PolarisError;
    expect(err.code).toBe("bad_response");
  });

  it("answers bad_response for a 200 that is not an access token", async () => {
    const { client } = await clientWith(() => answer({ token_type: "MAC" }));
    const err = (await client.identity
      .accessToken()
      .catch((e: unknown) => e)) as PolarisError;
    expect(err.code).toBe("bad_response");
  });
});
