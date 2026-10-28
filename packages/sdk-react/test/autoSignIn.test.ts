// @vitest-environment node
//
// @pkey-feature identity.autosignin
//
// The web `autoSignIn()` ladder (I-46.4; plan-auto-sign-in §1, scenario 8; D-A12): rung 1 (a
// stored token), rung 3 (the provider, silent), rung 4 (its chooser, only with
// `prompt: "optional"`), the explicit-sign-out flag, `syncKey`, and the desktop answer. The
// exchange runs for real against a scripted Worker; the provider is a stub. Node environment:
// jsdom's cross-realm typed arrays make WebCrypto's Ed25519 verify reject every signature.

import { describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  createWebDeviceKeyStore,
  memoryDeviceKeyStorage,
  type DeviceKeyPort,
} from "@polaris-key/client-core";
import { indexedDbStore, memoryStore } from "../src/browser/bearer/store.js";
import {
  fedcmGoogleProvider,
  runAutoSignIn,
  runSignOutCleanup,
  type AutoSignInContext,
} from "../src/browser/bearer/autoSignIn.js";
import { exchangeDiscoveryOf } from "../src/browser/discovery.js";
import { indexedDbOfflineStore } from "../src/browser/offline.js";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { DesktopAdapter } from "../src/desktop/desktopAdapter.js";
import { discoveryBody, newTestKey, services } from "./fixtures.js";
import type {
  AutoSignInResult,
  PlatformIdentityProvider,
  PlatformMediation,
} from "../src/core/signIn.js";

import {
  ACCESS,
  GRANT,
  HANDLE,
  SUBJECT_TOKEN,
  durableKeys,
  json,
  TOKEN_BODY,
  exchangeSession,
  nonceOf,
} from "./exchangeFixtures.js";

const NOW = 1_700_000_000;
const DEVICE = "AUTOSIGNINDEVICE000000000000001";
const BASE = "https://key.plrs.im/acme/identity";

const EXCHANGE = {
  kinds: ["google"],
  google: { serverClientId: "1234-web.apps.googleusercontent.com" },
};
const ENDPOINTS = { nonce: `${BASE}/nonce`, token: `${BASE}/token` };

const discoveryOf = (exchange: unknown = EXCHANGE) => ({
  services: { identity: { enabled: true, exchange, endpoints: ENDPOINTS } },
});

type Respond = (n: number) => Response;

function rig(
  token: Respond = () => json(TOKEN_BODY),
  o: { discovery?: Record<string, unknown> | null } = {},
) {
  const calls: string[] = [];
  let nonces = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === ENDPOINTS.nonce) {
      nonces += 1;
      return json({ nonce: nonceOf(nonces), expiresIn: 300 });
    }
    if (url === ENDPOINTS.token) return token(nonces);
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const discovery = o.discovery === undefined ? discoveryOf() : o.discovery;
  const store = memoryStore("acme");
  const session = exchangeSession({
    fetchImpl,
    store,
    exchangeEndpoints: () => exchangeDiscoveryOf(discovery),
  });
  const port = durableKeys();
  return { session, store, port, calls, discovery };
}

/** A provider stub: answers `offer` per mediation, recording what it was asked. */
function stub(offer: Partial<Record<PlatformMediation, string | null>> = {}) {
  const asked: PlatformMediation[] = [];
  const provider: PlatformIdentityProvider = {
    kind: "google",
    available: () => true,
    token: async (_nonce, mediation) => {
      asked.push(mediation);
      return offer[mediation] ?? null;
    },
    signOutCleanup: vi.fn(async () => undefined),
  };
  return { provider, asked };
}

function ctxOf(
  r: ReturnType<typeof rig>,
  provider: PlatformIdentityProvider | null,
  o: Partial<AutoSignInContext> = {},
): AutoSignInContext {
  return {
    bearer: r.session,
    port: r.port,
    provider,
    endpoints: exchangeDiscoveryOf(r.discovery),
    explicitSignOut: async () =>
      (await r.store.explicitSignOut?.get()) === true,
    syncKey: async () => undefined,
    ...o,
  };
}

const interstitial = (reason: string, extra: Record<string, unknown> = {}) =>
  json(
    {
      error: "interstitial_required",
      reason,
      url: "https://key.plrs.im/acme/signin",
      linkHandle: HANDLE,
      ...extra,
    },
    403,
  );

describe("rung 1: a stored token", () => {
  it("is signedIn with no provider asked and no request made", async () => {
    const r = rig();
    await r.store.setToken("pkeyt_stored");
    const s = stub({ silent: SUBJECT_TOKEN });
    const out = await runAutoSignIn(ctxOf(r, s.provider));
    expect(out).toMatchObject({ kind: "signedIn", via: "stored" });
    expect(s.asked).toEqual([]);
    expect(r.calls).toEqual([]);
  });

  it("wins over an explicit sign-out flag (a token is a session)", async () => {
    const r = rig();
    await r.store.setToken("pkeyt_stored");
    await r.store.explicitSignOut!.set(true);
    expect(await runAutoSignIn(ctxOf(r, stub().provider))).toMatchObject({
      kind: "signedIn",
      via: "stored",
    });
  });
});

describe("rung 3: the provider asks silently", () => {
  it("exchanges the provider's token and stores the device token", async () => {
    const r = rig();
    const s = stub({ silent: SUBJECT_TOKEN });
    const out = await runAutoSignIn(ctxOf(r, s.provider));
    expect(out).toMatchObject({
      kind: "signedIn",
      via: "platform",
      subject: "ps_abc",
      activation: { licenseId: "lic-1" },
    });
    expect(s.asked).toEqual(["silent"]);
    expect(await r.store.getToken()).toBe(ACCESS);
  });

  it("falls to the form when the provider offers nothing, without a prompt", async () => {
    const r = rig();
    const s = stub();
    const out = await runAutoSignIn(ctxOf(r, s.provider));
    expect(out).toEqual({ kind: "needsSignIn", reason: "noCredential" });
    expect(s.asked).toEqual(["silent"]);
    expect(await r.store.getToken()).toBeNull();
    // The token endpoint was never called: only the nonce was spent.
    expect(r.calls.filter((u) => u.endsWith("/token"))).toEqual([]);
  });

  it("maps a pending consent to confirm, hiding the grant", async () => {
    const r = rig(() =>
      json({
        status: "confirm",
        grant: GRANT,
        expiresIn: 300,
        consent: {
          client: {
            appName: "acme",
            developerName: null,
            iconUrl: null,
            nameVerified: true,
          },
          as: { provider: "google", email: "ada@example.com" },
          items: [{ kind: "profile", claims: ["email"] }],
          scopeHash: "a".repeat(64),
          firstTime: true,
          changed: false,
        },
      }),
    );
    const out = await runAutoSignIn(
      ctxOf(r, stub({ silent: SUBJECT_TOKEN }).provider),
    );
    expect(out.kind).toBe("confirm");
    expect((out as { grant: string }).grant).toBe(GRANT);
    expect(JSON.stringify(out)).not.toContain(GRANT);
  });

  it("maps a licence choice to choose", async () => {
    const r = rig(() =>
      json({
        status: "choose",
        grant: GRANT,
        expiresIn: 300,
        choices: { state: "one" },
      }),
    );
    const out = await runAutoSignIn(
      ctxOf(r, stub({ silent: SUBJECT_TOKEN }).provider),
    );
    expect(out).toMatchObject({ kind: "choose", expiresIn: 300 });
    expect(JSON.stringify(out)).not.toContain(GRANT);
  });

  it.each([
    ["no_link", "noLink", HANDLE],
    // An unknown reason is a no_link that carries no handle.
    ["something_new", "noLink", undefined],
  ])("maps the interstitial %s to %s", async (wire, reason, handle) => {
    const r = rig(() => interstitial(wire, { expiresIn: 600 }));
    const out = await runAutoSignIn(
      ctxOf(r, stub({ silent: SUBJECT_TOKEN }).provider),
    );
    expect(out).toMatchObject({ kind: "needsSignIn", reason });
    expect((out as { linkHandle?: string }).linkHandle).toBe(handle);
    expect(JSON.stringify(out)).not.toContain(HANDLE);
  });

  it("maps device_limit to a result", async () => {
    const r = rig(() => json({ error: "device_limit" }, 403));
    const out = await runAutoSignIn(
      ctxOf(r, stub({ silent: SUBJECT_TOKEN }).provider),
    );
    expect(out.kind).toBe("deviceLimit");
  });

  it("treats an older Worker's unsupported_grant_type as a failed rung", async () => {
    const r = rig(() => json({ error: "unsupported_grant_type" }, 400));
    const out = await runAutoSignIn(
      ctxOf(r, stub({ silent: SUBJECT_TOKEN }).provider),
    );
    expect(out).toEqual({ kind: "needsSignIn", reason: "noCredential" });
  });

  it("throws a typed error for any other refusal", async () => {
    const r = rig(() => json({ error: "invalid_grant" }, 400));
    await expect(
      runAutoSignIn(ctxOf(r, stub({ silent: SUBJECT_TOKEN }).provider)),
    ).rejects.toMatchObject({ name: "PolarisError" });
  });

  it("is unavailable where the product serves none, or not this kind", async () => {
    const none = rig(undefined, { discovery: null });
    expect(
      await runAutoSignIn(
        ctxOf(none, stub({ silent: SUBJECT_TOKEN }).provider),
      ),
    ).toEqual({ kind: "unavailable", code: "product" });
    const apple = rig(undefined, {
      discovery: discoveryOf({ kinds: ["apple"] }),
    });
    expect(
      await runAutoSignIn(
        ctxOf(apple, stub({ silent: SUBJECT_TOKEN }).provider),
      ),
    ).toEqual({ kind: "unavailable", code: "kind" });
  });

  it("is unavailable when discovery names an endpoint off the product's origin", async () => {
    const off = rig(undefined, {
      discovery: {
        services: {
          identity: {
            enabled: true,
            exchange: EXCHANGE,
            endpoints: {
              nonce: "https://evil.example/nonce",
              token: ENDPOINTS.token,
            },
          },
        },
      },
    });
    const s = stub({ silent: SUBJECT_TOKEN });
    expect(await runAutoSignIn(ctxOf(off, s.provider))).toEqual({
      kind: "unavailable",
      code: "endpoint",
    });
    expect(s.asked).toEqual([]);
  });

  it("goes to the form where the browser has no provider (Safari, Firefox)", async () => {
    const r = rig();
    expect(await runAutoSignIn(ctxOf(r, null))).toEqual({
      kind: "needsSignIn",
      reason: "noCredential",
    });
    const s = stub({ silent: SUBJECT_TOKEN });
    s.provider.available = () => false;
    expect(await runAutoSignIn(ctxOf(r, s.provider))).toEqual({
      kind: "needsSignIn",
      reason: "noCredential",
    });
    expect(s.asked).toEqual([]);
  });
});

describe("rung 4: the chooser, only with prompt: optional (D-A12)", () => {
  it("is not tried by default", async () => {
    const r = rig();
    const s = stub({ optional: SUBJECT_TOKEN });
    expect(await runAutoSignIn(ctxOf(r, s.provider))).toEqual({
      kind: "needsSignIn",
      reason: "noCredential",
    });
    expect(s.asked).toEqual(["silent"]);
  });

  it('is tried after a silent miss with prompt: "optional", with its own nonce', async () => {
    const r = rig();
    const s = stub({ optional: SUBJECT_TOKEN });
    const out = await runAutoSignIn(ctxOf(r, s.provider), {
      prompt: "optional",
    });
    expect(out).toMatchObject({ kind: "signedIn", via: "platform" });
    expect(s.asked).toEqual(["silent", "optional"]);
    expect(r.calls.filter((u) => u.endsWith("/nonce"))).toHaveLength(2);
  });

  it("is skipped when the silent rung already signed in", async () => {
    const r = rig();
    const s = stub({ silent: SUBJECT_TOKEN, optional: SUBJECT_TOKEN });
    await runAutoSignIn(ctxOf(r, s.provider), { prompt: "optional" });
    expect(s.asked).toEqual(["silent"]);
  });
});

describe("the explicit sign-out flag", () => {
  it("skips rungs 3 and 4 while set, even with prompt: optional", async () => {
    const r = rig();
    await r.store.explicitSignOut!.set(true);
    const s = stub({ silent: SUBJECT_TOKEN, optional: SUBJECT_TOKEN });
    expect(
      await runAutoSignIn(ctxOf(r, s.provider), { prompt: "optional" }),
    ).toEqual({ kind: "needsSignIn", reason: "signedOut" });
    expect(s.asked).toEqual([]);
    expect(r.calls).toEqual([]);
  });

  it("survives a reload of the IndexedDB store, and clears", async () => {
    const factory = new IDBFactory();
    const a = indexedDbStore("acme", { factory })!;
    expect(await a.explicitSignOut!.get()).toBe(false);
    await a.explicitSignOut!.set(true);
    expect(
      await indexedDbStore("acme", { factory })!.explicitSignOut!.get(),
    ).toBe(true);
    expect(
      await indexedDbStore("other", { factory })!.explicitSignOut!.get(),
    ).toBe(false);
    // It is not the token: clearing the token keeps it, and it is not read as one.
    await a.clearToken();
    expect(await a.getToken()).toBeNull();
    expect(await a.explicitSignOut!.get()).toBe(true);
    await a.explicitSignOut!.set(false);
    expect(await a.explicitSignOut!.get()).toBe(false);
  });
});

describe("syncKey (Q-8)", () => {
  it("rides on signedIn from the ring when E2E is on, and is absent otherwise", async () => {
    for (const key of ["present", "needed"] as const) {
      const r = rig();
      const out = await runAutoSignIn(
        ctxOf(r, stub({ silent: SUBJECT_TOKEN }).provider, {
          syncKey: async () => key,
        }),
      );
      expect(out).toMatchObject({ kind: "signedIn", syncKey: key });
    }
    const r = rig();
    await r.store.setToken("pkeyt_stored");
    const stored = await runAutoSignIn(
      ctxOf(r, null, { syncKey: async () => "needed" }),
    );
    expect(stored).toMatchObject({ via: "stored", syncKey: "needed" });
    const off = await runAutoSignIn(
      ctxOf(rig(), stub({ silent: SUBJECT_TOKEN }).provider),
    );
    expect("syncKey" in off).toBe(false);
  });
});

describe("the FedCM provider", () => {
  it("is available only with FedCM and a client id, and asks with the client id", async () => {
    const p = fedcmGoogleProvider(() => undefined);
    expect(p.available()).toBe(false);
    expect(await p.token("n".repeat(43), "silent")).toBeNull();
    await expect(p.signOutCleanup()).resolves.toBeUndefined();
    await expect(runSignOutCleanup(null)).resolves.toBeUndefined();
    const boom: PlatformIdentityProvider = {
      ...stub().provider,
      signOutCleanup: async () => {
        throw new Error("x");
      },
    };
    await expect(runSignOutCleanup(boom)).resolves.toBeUndefined();
  });
});

describe("through the browser adapter", () => {
  async function adapterRig(provider: PlatformIdentityProvider | null) {
    const key = await newTestKey("pkey-test-auto");
    const disc = JSON.parse(
      discoveryBody(services("license", "identity", "config")),
    );
    disc.core = { registration: "requires-license" };
    disc.services.identity = {
      enabled: true,
      exchange: EXCHANGE,
      endpoints: ENDPOINTS,
    };
    let nonces = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/acme/.well-known/polaris.json") return json(disc);
      if (url.pathname === "/acme/.well-known/polaris-trust.jws")
        return new Response("", { status: 404 });
      if (url.href === ENDPOINTS.nonce) {
        nonces += 1;
        return json({ nonce: nonceOf(nonces), expiresIn: 300 });
      }
      if (url.href === ENDPOINTS.token)
        return json({ error: "invalid_grant" }, 400);
      if (url.pathname === "/acme/license/activate")
        return json({ token: "pkeyt_one", schemaVersion: 1 });
      if (url.pathname === "/acme/license/deauthorize")
        return json({ ok: true });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const factory = new IDBFactory();
    await indexedDbOfflineStore(factory)!.write("acme", { deviceId: DEVICE });
    const store = indexedDbStore("acme", { factory })!;
    const adapter = browserAdapter({
      productSlug: "acme",
      auth: "bearer",
      trust: { pinnedKeys: { [key.kid]: key.raw } },
      fetchImpl,
      now: () => NOW,
      store,
      platformIdentity: provider,
      keyring: {
        deviceKeys: createWebDeviceKeyStore({
          storage: memoryDeviceKeyStorage(),
        }),
      },
    });
    return { adapter, store };
  }

  it("signOut sets the flag, then runs the provider's cleanup; autoSignIn then stays at the form", async () => {
    const s = stub({ silent: SUBJECT_TOKEN, optional: SUBJECT_TOKEN });
    const { adapter, store } = await adapterRig(s.provider);
    await adapter.signOut();
    expect(s.provider.signOutCleanup).toHaveBeenCalledTimes(1);
    expect(await store.explicitSignOut!.get()).toBe(true);
    const out: AutoSignInResult = await (
      adapter as unknown as {
        autoSignIn(o: unknown): Promise<AutoSignInResult>;
      }
    ).autoSignIn({ prompt: "optional" });
    expect(out).toEqual({ kind: "needsSignIn", reason: "signedOut" });
    expect(s.asked).toEqual([]);
  });

  it("an explicit sign-in (a key activation) clears the flag", async () => {
    const s = stub();
    const { adapter, store } = await adapterRig(s.provider);
    await store.explicitSignOut!.set(true);
    expect(await adapter.autoSignIn()).toEqual({
      kind: "needsSignIn",
      reason: "signedOut",
    });
    expect(s.asked).toEqual([]);
    // The documents are not served here, so the sync after the activation may fail; the
    // activation itself is what clears the flag.
    await adapter.activateWithKey("pkey_good").catch(() => undefined);
    expect(await store.explicitSignOut!.get()).toBe(false);
  });

  it("answers unavailable on the desktop adapter", async () => {
    const bridge = {
      version: 1,
      call: async () => null,
      on: () => () => undefined,
    } as never;
    const desktop = new DesktopAdapter({ bridge, now: () => NOW });
    expect(await desktop.autoSignIn()).toEqual({
      kind: "unavailable",
      code: "runtime",
    });
  });
});
