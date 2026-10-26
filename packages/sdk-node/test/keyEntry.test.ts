// Key entries (PX-W9, WIRE-CONTRACT-V4 §12.2): `activateWithKey` reports `keyEntries` on success
// and answers `key-entry-limit` / `license-owned` as typed results. Neither refusal is an auth
// failure: the held token, the store and the cache stay as they were, and nothing is retried.

import { describe, expect, it } from "vitest";
import { PolarisKeyClient } from "../src/client.js";
import { InMemoryStore } from "../src/core/store.js";
import { activationRefusal, readKeyEntries } from "../src/license/endpoints.js";

const LIMIT_URL = "https://key.plrs.im/activate?product=djdl";
const SIGN_IN = "https://key.plrs.im/signin?product=djdl";

function client(
  store: InMemoryStore,
  status: number,
  body: unknown,
  calls: string[],
): Promise<PolarisKeyClient> {
  return PolarisKeyClient.create({
    productSlug: "djdl",
    baseUrl: "https://k.test",
    version: "1.2.3",
    trust: { pinnedKeys: {} },
    trustRefresh: false,
    license: { fingerprint: false },
    devices: { fingerprint: false },
    store,
    fetchImpl: (async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch,
  });
}

// @pkey-feature identity.keyentry
describe("key entries on activation", () => {
  it("maps key_entry_limit with its counts and manageUrl", () => {
    expect(
      activationRefusal(403, {
        error: "key_entry_limit",
        manageUrl: LIMIT_URL,
        keyEntries: { used: 2, limit: 2 },
      } as never),
    ).toEqual({
      kind: "key-entry-limit",
      code: "key_entry_limit",
      manageUrl: LIMIT_URL,
      keyEntries: { used: 2, limit: 2 },
    });
  });

  it("omits manageUrl while the portal is off, and drops an unsafe one", () => {
    for (const manageUrl of [undefined, "javascript:alert(1)"]) {
      const r = activationRefusal(403, {
        error: "key_entry_limit",
        ...(manageUrl ? { manageUrl } : {}),
        keyEntries: { used: 3, limit: 2 },
      } as never);
      expect(r).toEqual({
        kind: "key-entry-limit",
        code: "key_entry_limit",
        keyEntries: { used: 3, limit: 2 },
      });
    }
  });

  it("maps license_owned with its signInUrl", () => {
    expect(
      activationRefusal(403, {
        error: "license_owned",
        signInUrl: SIGN_IN,
      } as never),
    ).toEqual({
      kind: "license-owned",
      code: "license_owned",
      signInUrl: SIGN_IN,
    });
  });

  it("falls back to a plain refusal when the typed fields are missing or malformed", () => {
    expect(
      activationRefusal(403, { error: "key_entry_limit" } as never).kind,
    ).toBe("refused");
    expect(
      activationRefusal(403, {
        error: "key_entry_limit",
        keyEntries: { used: -1, limit: 2 },
      } as never).kind,
    ).toBe("refused");
    expect(
      activationRefusal(403, {
        error: "license_owned",
        signInUrl: "javascript:x",
      } as never).kind,
    ).toBe("refused");
  });

  it("reads keyEntries only as two non-negative integers", () => {
    expect(readKeyEntries({ keyEntries: { used: 0, limit: 10 } })).toEqual({
      used: 0,
      limit: 10,
    });
    expect(readKeyEntries({})).toBeUndefined();
    expect(
      readKeyEntries({ keyEntries: { used: 1.5, limit: 2 } }),
    ).toBeUndefined();
    expect(
      readKeyEntries({ keyEntries: { used: "1", limit: 2 } }),
    ).toBeUndefined();
  });

  it("returns keyEntries on success; none with Identity off", async () => {
    for (const [extra, want] of [
      [{ keyEntries: { used: 1, limit: 10 } }, { used: 1, limit: 10 }],
      [{}, undefined],
    ] as const) {
      const store = new InMemoryStore("djdl");
      const c = await client(
        store,
        200,
        { token: "pkeyt_new", schemaVersion: 1, ...extra },
        [],
      );
      const r = await c.license.activateWithKey(
        "pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA",
      );
      expect(r.kind).toBe("ok");
      expect((r as { keyEntries?: unknown }).keyEntries).toEqual(want);
    }
  });

  for (const [name, body, kind] of [
    [
      "key-entry-limit",
      { error: "key_entry_limit", keyEntries: { used: 2, limit: 2 } },
      "key-entry-limit",
    ],
    [
      "license-owned",
      { error: "license_owned", signInUrl: SIGN_IN },
      "license-owned",
    ],
  ] as const) {
    it(`${name} keeps the token and store, and does not retry`, async () => {
      const store = new InMemoryStore("djdl");
      await store.setToken("pkeyt_held");
      const calls: string[] = [];
      const c = await client(store, 403, body, calls);
      const r = await c.license.activateWithKey(
        "pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA",
      );
      expect(r.kind).toBe(kind);
      expect(await store.getToken()).toBe("pkeyt_held");
      expect(calls).toEqual(["https://k.test/djdl/license/activate"]);
    });
  }
});
