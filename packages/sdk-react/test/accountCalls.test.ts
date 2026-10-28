// @vitest-environment node
//
// @pkey-feature identity.keyentry identity.account identity.attach license.activate
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
}

async function server(opts: { account?: boolean } = {}): Promise<Server> {
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
        endpoints: {
          session: `${origin}/identity/session`,
          authStart: `${origin}/identity/auth/start`,
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
  };
}

async function bearer(s: Server) {
  const factory = new IDBFactory();
  await indexedDbOfflineStore(factory)!.write("acme", { deviceId: DEVICE });
  const adapter = browserAdapter({
    ...BEARER,
    trust: { pinnedKeys: { [s.key.kid]: s.key.raw } },
    fetchImpl: s.fetchImpl,
    store: indexedDbStore("acme", { factory, persistence: PERSISTED })!,
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

  it("a cookie page refuses them with the runtime reason", async () => {
    const adapter = browserAdapter({
      auth: "cookie",
      productSlug: "acme",
      offlineStore: null,
      autoStart: false,
    });
    for (const f of [Feature.identityAccount, Feature.identityAttach])
      expect(adapter.supports(f)).toMatchObject({ supported: false });
    await expect(adapter.subject()).rejects.toMatchObject({
      reason: "runtime",
    });
    await expect(adapter.attach({ confirm: false })).rejects.toMatchObject({
      reason: "runtime",
    });
    await expect(adapter.openAccount()).rejects.toMatchObject({
      reason: "runtime",
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
