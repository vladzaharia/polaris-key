// @vitest-environment node
//
// @pkey-feature identity.keyentry identity.account identity.attach license.activate identity.accesstoken
//
// I-10a.9: the activation outcomes and the account calls through the ADAPTERS (the transcript
// replayer drives the bearer engine; this is what the adapter adds): `activateWithKey` resolves
// with `keyEntries` and keeps every piece of state on `key_entry_limit` and `license_owned`;
// `subject()`, `signOut()`, `attach()` and `openAccount()` follow discovery's identity fragment
// in bearer mode, refuse typed on a cookie page, and cross the desktop bridge as `invoke("identity", …)`.

import { describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { indexedDbStore } from "../src/browser/bearer/store.js";
import { indexedDbOfflineStore } from "../src/browser/offline.js";
import { Feature } from "../src/constants.generated.js";
import { DesktopAdapter } from "../src/desktop/desktopAdapter.js";
import {
  makeFakeBridge,
  newTestKey,
  okBridgeState,
  settled,
  signedDocs,
  FIXTURE_TRUST,
} from "./fixtures.js";

const NOW = 1_700_000_000;
const BEARER = {
  productSlug: "acme",
  auth: "bearer",
  now: () => NOW,
  version: "1.2.0",
} as const;
const PERSISTED = { persisted: async () => true };
const DEVICE = "BEARERDEVICE00000000000000000001";

interface Server {
  fetchImpl: typeof fetch;
  seen: Array<{ method: string; path: string; body: string | null }>;
  key: Awaited<ReturnType<typeof newTestKey>>;
  setActivate(r: { status: number; body: unknown }): void;
  setSignout(released: boolean): void;
  /** What the token route answers (identity.accesstoken). */
  exchange: { status: number; reply: () => unknown };
}

async function server(
  opts: { account?: boolean; accessToken?: boolean } = {},
): Promise<Server> {
  const account = opts.account ?? true;
  const key = await newTestKey("pkey-test-account");
  const { license, config } = await signedDocs(key, {
    aud: "acme",
    deviceId: DEVICE,
    now: NOW,
  });
  const seen: Server["seen"] = [];
  let activate = {
    status: 200,
    body: {
      token: "pkeyt_one",
      schemaVersion: 1,
      keyEntries: { used: 1, limit: 2 },
    } as unknown,
  };
  let released = true;
  const exchange = {
    status: 200,
    reply: (): unknown => ({
      access_token: "aaa.bbb.ccc",
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      token_type: "Bearer",
      expires_in: 600,
      scope: "",
    }),
  };
  const origin = "https://key.plrs.im/acme";
  const disc = {
    version: 2,
    protocolVersion: 4,
    product: "acme",
    slug: "acme",
    baseUrl: "https://key.plrs.im",
    core: { registration: "requires-license" },
    services: {
      license: {
        enabled: true,
        endpoints: { document: `${origin}/license/document` },
      },
      config: {
        enabled: true,
        endpoints: { document: `${origin}/config/document` },
      },
      identity: {
        enabled: true,
        ...(opts.accessToken ? { accessToken: true } : {}),
        endpoints: {
          session: `${origin}/identity/session`,
          authStart: `${origin}/identity/auth/start`,
          ...(opts.accessToken ? { token: `${origin}/identity/token` } : {}),
          ...(account
            ? {
                subject: `${origin}/identity/subject`,
                signout: `${origin}/identity/signout`,
                attach: `${origin}/identity/attach`,
                accountPortal: "https://key.plrs.im/#/p/acme",
              }
            : {}),
        },
      },
    },
  };
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    const url = new URL(String(input));
    seen.push({
      method: init.method ?? "GET",
      path: url.pathname,
      body: typeof init.body === "string" ? init.body : null,
    });
    switch (url.pathname) {
      case "/acme/.well-known/polaris.json":
        return json(disc);
      case "/acme/license/activate":
        return json(activate.body, activate.status);
      case "/acme/license/document":
        return new Response(license, { status: 200 });
      case "/acme/config/document":
        return new Response(config, { status: 200 });
      case "/acme/devices/report":
        return json({ ok: true });
      case "/acme/identity/token":
        return json(exchange.reply(), exchange.status);
      case "/acme/identity/subject":
        return json({ subject: "ps_abc" });
      case "/acme/identity/signout":
        return json({ released });
      case "/acme/identity/attach":
        return json({
          status: "confirm",
          license: { id: "lic-1", tierId: null, name: "Ada" },
        });
      case "/acme/license/deauthorize":
        return json({ ok: true });
      default:
        return new Response("not found", { status: 404 });
    }
  }) as typeof fetch;
  return {
    fetchImpl,
    seen,
    key,
    setActivate: (r) => {
      activate = r;
    },
    setSignout: (r) => {
      released = r;
    },
    exchange,
  };
}

async function bearer(
  s: Server,
  store?: (factory: IDBFactory) => ReturnType<typeof indexedDbStore>,
  now: () => number = BEARER.now,
) {
  const factory = new IDBFactory();
  await indexedDbOfflineStore(factory)!.write("acme", { deviceId: DEVICE });
  const adapter = browserAdapter({
    ...BEARER,
    now,
    trust: { pinnedKeys: { [s.key.kid]: s.key.raw } },
    fetchImpl: s.fetchImpl,
    store:
      store?.(factory) ??
      indexedDbStore("acme", { factory, persistence: PERSISTED })!,
  });
  await settled(adapter);
  return adapter;
}

describe("bearer: activateWithKey outcomes", () => {
  it("resolves with the licence's key entries", async () => {
    const adapter = await bearer(await server());
    await expect(adapter.activateWithKey("pkey_good")).resolves.toEqual({
      keyEntries: { used: 1, limit: 2 },
    });
    expect(adapter.snapshot().status).toBe("ok");
  });

  it("key_entry_limit is a typed refusal with the portal link and the entries; state is kept", async () => {
    const s = await server();
    const adapter = await bearer(s);
    await adapter.activateWithKey("pkey_good");
    s.setActivate({
      status: 403,
      body: {
        error: "key_entry_limit",
        manageUrl: "https://key.plrs.im/activate?product=acme",
        keyEntries: { used: 2, limit: 2 },
      },
    });
    const err = await adapter
      .activateWithKey("pkey_other")
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "sign-in-failed",
      wireCode: "key_entry_limit",
      manageUrl: "https://key.plrs.im/activate?product=acme",
      activation: {
        kind: "keyEntryLimit",
        keyEntries: { used: 2, limit: 2 },
      },
    });
    // Nothing was cleared, nothing retried.
    expect(adapter.snapshot().status).toBe("ok");
    expect(
      s.seen.filter((r) => r.path === "/acme/license/activate"),
    ).toHaveLength(2);
    expect(s.seen.some((r) => r.path === "/acme/license/deauthorize")).toBe(
      false,
    );
  });

  it("license_owned is a typed refusal with the sign-in link", async () => {
    const s = await server();
    const adapter = await bearer(s);
    s.setActivate({
      status: 403,
      body: {
        error: "license_owned",
        signInUrl: "https://key.plrs.im/signin?product=acme",
      },
    });
    const err = await adapter
      .activateWithKey("pkey_x")
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      wireCode: "license_owned",
      activation: {
        kind: "licenseOwned",
        signInUrl: "https://key.plrs.im/signin?product=acme",
      },
    });
    expect(adapter.snapshot().status).toBe("needs-activation");
  });

  it("drops a sign-in link that is not https", async () => {
    const s = await server();
    const adapter = await bearer(s);
    s.setActivate({
      status: 403,
      body: { error: "license_owned", signInUrl: "javascript:alert(1)" },
    });
    const err = (await adapter
      .activateWithKey("k")
      .catch((e: unknown) => e)) as {
      activation: { signInUrl?: string };
    };
    expect(err.activation.signInUrl).toBeUndefined();
  });
});

describe("bearer: the account calls", () => {
  it("subject, attach preview and signOut follow discovery's identity fragment", async () => {
    const s = await server();
    const adapter = await bearer(s);
    await adapter.activateWithKey("pkey_good");
    expect(await adapter.subject()).toBe("ps_abc");
    expect(await adapter.attach({ confirm: false })).toEqual({
      kind: "confirm",
      license: { id: "lic-1", tierId: null, name: "Ada" },
    });
    const sent = s.seen.find((r) => r.path === "/acme/identity/attach")!;
    expect(sent.body).toBe('{"confirm":false}');

    const order: string[] = [];
    adapter.onBeforeSignOut(async () => {
      order.push(`hook after ${s.seen.length}`);
    });
    const before = s.seen.length;
    expect(await adapter.signOut()).toEqual({ released: true });
    expect(order).toEqual([`hook after ${before}`]);
    expect(adapter.snapshot().status).toBe("needs-activation");
    // The server released the device: no separate deauthorize call.
    expect(s.seen.some((r) => r.path === "/acme/license/deauthorize")).toBe(
      false,
    );
  });

  it("signOut and a key-only deactivation forget the key ring's root and pin", async () => {
    const s = await server();
    const adapter = await bearer(s);
    await adapter.activateWithKey("pkey_good");
    const forget = vi.spyOn(adapter.keyring, "forget");
    await adapter.signOut();
    expect(forget).toHaveBeenCalledTimes(1);
    const bare = await server({ account: false });
    const second = await bearer(bare);
    await second.activateWithKey("pkey_good");
    const forget2 = vi.spyOn(second.keyring, "forget");
    await second.signOut();
    expect(forget2).toHaveBeenCalledTimes(1);
  });

  it("the key ring is forgotten before the release request, and a failed forget sends none", async () => {
    for (const account of [true, false]) {
      const path = account
        ? "/acme/identity/signout"
        : "/acme/license/deauthorize";
      const s = await server({ account });
      const adapter = await bearer(s);
      await adapter.activateWithKey("pkey_good");
      let sentAtForget = -1;
      const forget = vi
        .spyOn(adapter.keyring, "forget")
        .mockImplementationOnce(async () => {
          sentAtForget = s.seen.filter((r) => r.path === path).length;
        });
      await adapter.signOut();
      expect(forget).toHaveBeenCalledTimes(1);
      expect(sentAtForget).toBe(0);
      expect(s.seen.filter((r) => r.path === path)).toHaveLength(1);

      const s2 = await server({ account });
      const failing = await bearer(s2);
      await failing.activateWithKey("pkey_good");
      vi.spyOn(failing.keyring, "forget").mockRejectedValueOnce(
        new Error("store-failed"),
      );
      await expect(failing.signOut()).rejects.toBeDefined();
      expect(s2.seen.some((r) => r.path === path)).toBe(false);
      expect(failing.snapshot().status).toBe("ok");
    }
  });

  it("deauthorizing this device's own seat forgets the ring first", async () => {
    const s = await server({ account: false });
    const adapter = await bearer(s);
    await adapter.activateWithKey("pkey_good");
    let sent = -1;
    vi.spyOn(adapter.keyring, "forget").mockImplementationOnce(async () => {
      sent = s.seen.filter(
        (r) => r.path === "/acme/license/deauthorize",
      ).length;
    });
    const own = adapter.currentDevice()?.id;
    expect(own).toBeDefined();
    await adapter.deauthorizeDevice(own!);
    expect(sent).toBe(0);
  });

  it("deauthorizing this device's own seat sets the explicit sign-out flag the silent ladder reads", async () => {
    const s = await server({ account: false });
    let flag: { get(): Promise<boolean> } | undefined;
    const adapter = await bearer(s, (factory) => {
      const store = indexedDbStore("acme", {
        factory,
        persistence: PERSISTED,
      })!;
      flag = store.explicitSignOut;
      return store;
    });
    await adapter.activateWithKey("pkey_good");
    expect(await flag!.get()).toBe(false);
    const own = adapter.currentDevice()?.id;
    expect(own).toBeDefined();
    await adapter.deauthorizeDevice(own!);
    expect(await flag!.get()).toBe(true);
    // The property: a restore after the seat is gone stays quiet.
    expect(
      await (
        adapter as unknown as {
          autoSignIn(): Promise<{ kind: string; reason?: string }>;
        }
      ).autoSignIn(),
    ).toEqual({ kind: "needsSignIn", reason: "signedOut" });
  });

  it("released: false keeps the key activation", async () => {
    const s = await server();
    const adapter = await bearer(s);
    await adapter.activateWithKey("pkey_good");
    s.setSignout(false);
    expect(await adapter.signOut()).toEqual({ released: false });
    expect(adapter.snapshot().status).toBe("ok");
  });

  it("a product with no account endpoints answers the typed product N/A and signs out as before", async () => {
    const s = await server({ account: false });
    const adapter = await bearer(s);
    await adapter.activateWithKey("pkey_good");
    await expect(adapter.subject()).rejects.toMatchObject({
      code: "unsupported",
      feature: Feature.identityAccount,
      reason: "product",
    });
    await expect(adapter.attach({ confirm: true })).rejects.toMatchObject({
      reason: "product",
    });
    await expect(adapter.openAccount()).rejects.toMatchObject({
      reason: "product",
    });
    expect(await adapter.signOut()).toEqual({ released: true });
    expect(s.seen.some((r) => r.path === "/acme/license/deauthorize")).toBe(
      true,
    );
    expect(adapter.snapshot().status).toBe("needs-activation");
  });

  it("a page without pinned keys refuses them", async () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      offlineStore: null,
      autoStart: false,
    });
    for (const f of [Feature.identityAccount, Feature.identityAttach])
      expect(adapter.supports(f)).toMatchObject({ supported: false });
    await expect(adapter.subject()).rejects.toMatchObject({
      code: "invalid-options",
    });
    await expect(adapter.attach({ confirm: false })).rejects.toMatchObject({
      code: "invalid-options",
    });
    await expect(adapter.openAccount()).rejects.toMatchObject({
      code: "invalid-options",
    });
  });
});

describe("bearer: accessToken() (identity.accesstoken)", () => {
  const exchanges = (s: Server) =>
    s.seen.filter((r) => r.path === "/acme/identity/token");

  it("trades the device token, reuses it until 60 s before expiry, and asks again on refresh", async () => {
    const s = await server({ accessToken: true });
    let clock = NOW;
    const adapter = await bearer(s, undefined, () => clock);
    await adapter.activateWithKey("pkey_good");
    const got = await adapter.accessToken();
    expect(got).toEqual({
      accessToken: "aaa.bbb.ccc",
      tokenType: "Bearer",
      expiresIn: 600,
      expiresAt: NOW + 600,
    });
    const form = new URLSearchParams(exchanges(s)[0]!.body ?? "");
    expect(form.get("subject_token")).toBe("pkeyt_one");
    expect(form.get("client_id")).toBe("acme");
    clock = NOW + 539;
    expect((await adapter.accessToken()).expiresIn).toBe(61);
    expect(exchanges(s)).toHaveLength(1);
    clock = NOW + 540;
    await adapter.accessToken();
    expect(exchanges(s)).toHaveLength(2);
    await adapter.accessToken({ refresh: true });
    expect(exchanges(s)).toHaveLength(3);
  });

  it("is dropped at sign-out", async () => {
    const s = await server({ accessToken: true });
    const adapter = await bearer(s);
    await adapter.activateWithKey("pkey_good");
    await adapter.accessToken();
    s.setSignout(false);
    await adapter.signOut();
    await adapter.accessToken();
    expect(exchanges(s)).toHaveLength(2);
  });

  it("is the typed service-unavailable, with no exchange, when discovery names no accessToken", async () => {
    const s = await server();
    const adapter = await bearer(s);
    await adapter.activateWithKey("pkey_good");
    await expect(adapter.accessToken()).rejects.toMatchObject({
      code: "service-unavailable",
      feature: Feature.identityAccesstoken,
      reason: "product",
    });
    expect(exchanges(s)).toHaveLength(0);
  });

  it("raises the Worker's refusals under its own codes, with the wait on a 429", async () => {
    const s = await server({ accessToken: true });
    const adapter = await bearer(s);
    await adapter.activateWithKey("pkey_good");
    s.exchange.status = 400;
    s.exchange.reply = () => ({ error: "invalid_grant" });
    await expect(adapter.accessToken()).rejects.toMatchObject({
      code: "invalid_grant",
      status: 400,
    });
    s.exchange.status = 429;
    s.exchange.reply = () => ({ error: "rate_limited", retryAfter: 60 });
    await expect(adapter.accessToken()).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
      retryAfterSeconds: 60,
    });
    s.exchange.status = 200;
    s.exchange.reply = () => ({ access_token: "nope" });
    await expect(adapter.accessToken()).rejects.toMatchObject({
      code: "bad_response",
    });
  });

  it("a page without pinned keys refuses it", async () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      offlineStore: null,
      autoStart: false,
    });
    await expect(adapter.accessToken()).rejects.toMatchObject({
      code: "invalid-options",
    });
  });
});

describe("desktop: over the bridge, no new verb", () => {
  function desktop(overrides: Record<string, unknown> = {}) {
    const calls: unknown[][] = [];
    const bridge = {
      ...makeFakeBridge(okBridgeState()),
      version: 4,
      invoke: async (service: string, method: string, args?: unknown) => {
        calls.push([service, method, args]);
        if (method === "subject") return "ps_abc";
        if (method === "attach")
          return { kind: "refused", code: "account_required", status: 403 };
        return null;
      },
      ...overrides,
    };
    return { adapter: new DesktopAdapter({ bridge: bridge as never }), calls };
  }

  it("submitKey's answer carries keyEntries and the new refusals", async () => {
    const ok = desktop({
      submitKey: async () => ({
        kind: "ok",
        keyEntries: { used: 3, limit: 10 },
      }),
    });
    await expect(ok.adapter.activateWithKey("k")).resolves.toEqual({
      keyEntries: { used: 3, limit: 10 },
    });
    const limit = desktop({
      submitKey: async () => ({
        kind: "key-entry-limit",
        manageUrl: "https://key.plrs.im/activate?product=acme",
        keyEntries: { used: 2, limit: 2 },
      }),
    });
    await expect(limit.adapter.activateWithKey("k")).rejects.toMatchObject({
      activation: {
        kind: "keyEntryLimit",
        manageUrl: "https://key.plrs.im/activate?product=acme",
        keyEntries: { used: 2, limit: 2 },
      },
    });
    const owned = desktop({
      submitKey: async () => ({
        kind: "license-owned",
        signInUrl: "https://key.plrs.im/signin?product=acme",
      }),
    });
    await expect(owned.adapter.activateWithKey("k")).rejects.toMatchObject({
      activation: {
        kind: "licenseOwned",
        signInUrl: "https://key.plrs.im/signin?product=acme",
      },
    });
    // A host that sends the code as a plain refusal classifies the same way.
    const refused = desktop({
      submitKey: async () => ({
        kind: "refused",
        code: "key_entry_limit",
        status: 403,
      }),
    });
    await expect(refused.adapter.activateWithKey("k")).rejects.toMatchObject({
      activation: { kind: "keyEntryLimit" },
    });
  });

  it("the account calls go through invoke('identity', …)", async () => {
    const { adapter, calls } = desktop();
    expect(await adapter.subject()).toBe("ps_abc");
    expect(await adapter.attach({ confirm: true })).toEqual({
      kind: "refused",
      code: "account_required",
      status: 403,
    });
    await adapter.openAccount();
    expect(calls).toEqual([
      ["identity", "subject", undefined],
      ["identity", "attach", { confirm: true }],
      ["identity", "openAccount", undefined],
    ]);
  });

  it("accessToken goes through invoke('identity', 'accessToken') and checks the answer", async () => {
    const token = {
      accessToken: "aaa.bbb.ccc",
      tokenType: "Bearer",
      expiresIn: 600,
      expiresAt: NOW + 600,
    };
    const ok = desktop({
      invoke: async (...a: unknown[]) => (ok.calls.push(a), token),
    });
    expect(await ok.adapter.accessToken({ refresh: true })).toEqual(token);
    expect(ok.calls).toEqual([["identity", "accessToken", { refresh: true }]]);
    const empty = desktop({ invoke: async () => null });
    await expect(empty.adapter.accessToken()).rejects.toMatchObject({
      code: "bad_response",
    });
    const denied = desktop({
      invoke: async () => {
        throw Object.assign(new Error("no"), { code: "invoke-not-allowed" });
      },
    });
    await expect(denied.adapter.accessToken()).rejects.toMatchObject({
      code: "unsupported",
      feature: Feature.identityAccesstoken,
    });
  });

  it("a host that does not allowlist them, or speaks v3, answers the typed version N/A", async () => {
    const denied = desktop({
      invoke: async () => {
        throw Object.assign(new Error("no"), { code: "invoke-not-allowed" });
      },
    });
    await expect(denied.adapter.subject()).rejects.toMatchObject({
      code: "unsupported",
      reason: "version",
    });
    const v3 = desktop({ version: 3 });
    await expect(v3.adapter.attach({ confirm: false })).rejects.toMatchObject({
      reason: "version",
    });
  });

  it("signOut reports whether the device was released", async () => {
    const { adapter } = desktop();
    expect(await adapter.signOut()).toEqual({ released: true });
  });
});
