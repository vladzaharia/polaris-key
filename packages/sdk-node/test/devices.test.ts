// The Devices sub-client — the Core device principal's own surface (wire contract v3 §6).
//
// §6 is the change that stopped "device" being a licensing concept. Until v3 the only way to
// become a device was to present a licence key; D-08 gives a config-only product's installs an
// identity to fetch a document AS and a credential to fetch it WITH, keylessly, through
// `POST /<p>/devices/register`. The rest of the surface — list / rename / deauthorize / report —
// is Core's under EVERY registration policy, which is why it lives here rather than under
// License.
//
// What this suite pins, all at the unit level against a recording transport:
//
//   * REGISTER SENDS NO BEARER, even holding a stale one. Re-registering asks for a FRESH
//     credential; authenticating with the old token would make the endpoint a rotation path it
//     is not, and would leak a credential the caller has already decided to replace.
//   * the §6 status ladder — 200 mints and STORES, 403 `registration-closed` (the policy is
//     `requires-license`/`requires-identity`), 429 `rate-limited`, 404 `not-configured`, and a
//     dropped connection `{kind:"error"}`. Every one is a RETURN, never a throw: registration
//     is a thing a host retries, not an exception.
//   * the fingerprint body is present or absent, never a placeholder — a host that opted out
//     sends a byte-identical request to one with nothing to report.
//   * `report()` NEVER throws and NEVER echoes the cache: R4-05. v1 sent the on-disk record back
//     to the control plane verbatim, so a forged local file authored the one signal that would
//     have revealed the forgery. The body below is built from documents `CacheManager`
//     re-verified microseconds earlier, and is `{}` when nothing verified.
//
// Every request is asserted for its route, method and the `X-PKey-*` device header, because
// those three are what the Worker's §6 handlers actually key on.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { signJws } from "@polaris-key/jws";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import type { CacheRecordV3, Store } from "@polaris-key/client-core";
import { PolarisKeyClient } from "../src/client.js";
import { CACHE_VERSION } from "../src/core/store.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));

interface CorpusKey {
  kid: string;
  publicKeyRaw: string;
  privateKeyPkcs8Pem: string;
}

const corpus = JSON.parse(
  readFileSync(
    join(here, "..", "..", "..", "conformance", "corpus", "v2", "cases.json"),
    "utf8",
  ),
) as { keys: CorpusKey[] };

const KID = "pkey-test-prod-2026";
const KEY = corpus.keys.find((k) => k.kid === KID);
if (!KEY) throw new Error(`corpus is missing key ${KID}`);
const PEM = KEY.privateKeyPkcs8Pem;
const PINNED = { [KID]: KEY.publicKeyRaw };

const PRODUCT = "djdl";
const DEVICE = "dev_7c1e2d";
const STALE_TOKEN = `pkeyt_${"S".repeat(43)}`;
const MINTED_TOKEN = `pkeyt_${"M".repeat(43)}`;
const NOW = Math.floor(Date.now() / 1000);

class FakeStore implements Store {
  token: string | null = null;
  cache: CacheRecordV3 | null = null;

  async getToken() {
    return this.token;
  }
  async setToken(t: string) {
    this.token = t;
  }
  async clearToken() {
    this.token = null;
  }
  async getDeviceId() {
    return DEVICE;
  }
  async readCache() {
    return this.cache;
  }
  async writeCache(rec: CacheRecordV3) {
    this.cache = rec;
  }
  async clearCache() {
    this.cache = null;
  }
}

/** One recorded request, reduced to what §6 actually keys on. */
interface Call {
  path: string;
  method: string;
  authorization: string | null;
  device: string | null;
  contentType: string | null;
  sdk: string | null;
  body: Record<string, unknown> | undefined;
}

type Responder = (path: string, method: string) => Response;

function recorder(respond: Responder) {
  const calls: Call[] = [];
  const impl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const headers = new Headers(init?.headers);
    calls.push({
      path: url.pathname,
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      device: headers.get("x-pkey-device"),
      contentType: headers.get("content-type"),
      sdk: headers.get("x-pkey-sdk"),
      body: init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined,
    });
    return respond(url.pathname, init?.method ?? "GET");
  }) as typeof fetch;
  const only = (): Call => {
    const call = calls[0];
    if (!call) throw new Error("no request was made");
    return call;
  };
  return { impl, calls, only };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

interface Harness {
  client: PolarisKeyClient;
  store: FakeStore;
  calls: Call[];
  only: () => Call;
}

async function harness(opts: {
  respond: Responder;
  token?: string | null;
  cache?: CacheRecordV3 | null;
  fingerprint?: boolean;
}): Promise<Harness> {
  const store = new FakeStore();
  store.token = opts.token ?? null;
  store.cache = opts.cache ?? null;
  const rec = recorder(opts.respond);
  const client = new PolarisKeyClient({
    productSlug: PRODUCT,
    baseUrl: "https://k.test",
    version: "1.2.3",
    trust: { pinnedKeys: PINNED },
    store,
    fetchImpl: rec.impl,
    ...(opts.fingerprint === undefined
      ? {}
      : { devices: { fingerprint: opts.fingerprint } }),
  });
  await client.init();
  return { client, store, calls: rec.calls, only: rec.only };
}

const ok =
  (body: unknown): Responder =>
  () =>
    json(body);
const status =
  (code: number): Responder =>
  () =>
    json({}, code);

// ══════════════════════════════════════════════════════════════════════════════════════════

// @pkey-feature devices.register
describe("devices.register() — the keyless mint path (§6)", () => {
  it("POSTs /<p>/devices/register with the device header and NO Authorization, even holding a stale token", async () => {
    // §6: a client re-registering is asking for a FRESH credential, not authenticating with
    // the old one. If the bearer went out, the endpoint would be a rotation path — and a
    // device whose token was compromised could never cleanly replace it.
    const h = await harness({
      respond: ok({ token: MINTED_TOKEN, deviceId: DEVICE }),
      token: STALE_TOKEN,
      fingerprint: false,
    });

    const result = await h.client.devices.register();
    expect(result).toEqual({
      kind: "ok",
      token: MINTED_TOKEN,
      deviceId: DEVICE,
    });

    const call = h.only();
    expect(call.path).toBe(`/${PRODUCT}/devices/register`);
    expect(call.method).toBe("POST");
    expect(call.authorization).toBeNull();
    expect(call.device).toBe(DEVICE);
    // The seven `X-PKey-*` client-metadata headers ride every product-scoped call.
    expect(call.sdk).toBeTruthy();
    // 200 REPLACES whatever was stored — the mint is the point of the call.
    expect(await h.store.getToken()).toBe(MINTED_TOKEN);
  });

  it("maps the §6 status ladder onto results, never onto exceptions", async () => {
    const ladder: [number, string][] = [
      // The policy is `requires-license`/`requires-identity`: activation or a sign-in is the
      // mint path, and the endpoint refuses without saying which.
      [403, "registration-closed"],
      [429, "rate-limited"],
      // No `devices.registration` configured for the product at all.
      [404, "not-configured"],
    ];
    for (const [code, kind] of ladder) {
      const h = await harness({ respond: status(code), fingerprint: false });
      await expect(h.client.devices.register()).resolves.toEqual({ kind });
      // A refusal mints nothing.
      expect(await h.store.getToken()).toBeNull();
    }
  });

  it('reports an unexpected status as {kind:"error"} carrying the body', async () => {
    const h = await harness({
      respond: () => new Response("upstream exploded", { status: 500 }),
      fingerprint: false,
    });
    await expect(h.client.devices.register()).resolves.toEqual({
      kind: "error",
      message: "upstream exploded",
    });
  });

  it('reports a dropped connection as {kind:"error"} rather than throwing', async () => {
    const h = await harness({
      respond: () => {
        throw new Error("ECONNREFUSED");
      },
      fingerprint: false,
    });
    await expect(h.client.devices.register()).resolves.toEqual({
      kind: "error",
      message: "ECONNREFUSED",
    });
    expect(await h.store.getToken()).toBeNull();
  });
});

// @pkey-feature devices.register
describe("devices.register() — the fingerprint body is present or absent, never faked", () => {
  it("sends {fingerprint} as JSON when collection is enabled and produced one", async () => {
    const h = await harness({
      respond: ok({ token: MINTED_TOKEN, deviceId: DEVICE }),
      fingerprint: true,
    });
    // `fingerprint()` hashes every component ON the device, so the raw serial/UUID/MAC never
    // crosses the wire. CPU model and RAM bucket are readable from any Node process, so this
    // host always produces one.
    const fingerprint = h.client.devices.fingerprint();
    expect(fingerprint).not.toBeNull();
    expect(fingerprint?.hwid).toBeTruthy();

    await h.client.devices.register();
    const call = h.only();
    expect(call.contentType).toBe("application/json");
    expect(call.body).toEqual({ fingerprint });
  });

  it("sends NO body and no content-type when `devices: {fingerprint: false}`", async () => {
    // An opted-out host must send a request byte-identical to one that simply had nothing to
    // report; the server records it as `unverified` rather than refusing it.
    const h = await harness({
      respond: ok({ token: MINTED_TOKEN, deviceId: DEVICE }),
      fingerprint: false,
    });
    expect(h.client.devices.fingerprint()).toBeNull();

    await h.client.devices.register();
    const call = h.only();
    expect(call.body).toBeUndefined();
    expect(call.contentType).toBeNull();
  });
});

// @pkey-feature devices.manage
describe("devices.list() — the product's roster for this credential", () => {
  it("GETs /<p>/devices with the bearer and returns body.devices", async () => {
    const roster = [
      { id: DEVICE, status: "active", current: true, label: "Studio" },
      { id: "dev_other", status: "active", current: false, label: null },
    ];
    const h = await harness({
      respond: ok({ devices: roster }),
      token: STALE_TOKEN,
    });

    await expect(h.client.devices.list()).resolves.toEqual(roster);
    const call = h.only();
    expect(call.path).toBe(`/${PRODUCT}/devices`);
    expect(call.method).toBe("GET");
    expect(call.authorization).toBe(`Bearer ${STALE_TOKEN}`);
    expect(call.device).toBe(DEVICE);
  });

  it("returns [] when the body carries no `devices` array", async () => {
    const h = await harness({ respond: ok({}), token: STALE_TOKEN });
    await expect(h.client.devices.list()).resolves.toEqual([]);
  });

  it("throws DeviceManagementUnsupportedError with NO token — and makes no request", async () => {
    // There is no roster without a credential, and probing for one would tell an unactivated
    // install nothing it could act on.
    const h = await harness({ respond: ok({ devices: [] }) });
    await expect(h.client.devices.list()).rejects.toMatchObject({
      name: "DeviceManagementUnsupportedError",
      code: "device-management-unsupported",
    });
    expect(h.calls).toHaveLength(0);
  });

  it("throws on a non-OK status", async () => {
    const h = await harness({ respond: status(500), token: STALE_TOKEN });
    await expect(h.client.devices.list()).rejects.toThrow(
      "device list failed: 500",
    );
  });
});

// @pkey-feature devices.manage
describe("devices.rename() / .deauthorize() — the per-device routes", () => {
  it("PATCHes /<p>/devices/:id with {label} and DELETEs the same path", async () => {
    const h = await harness({ respond: ok({}), token: STALE_TOKEN });

    await expect(
      h.client.devices.rename("dev_other", "Studio Mac"),
    ).resolves.toBeUndefined();
    await expect(
      h.client.devices.deauthorize("dev_other"),
    ).resolves.toBeUndefined();

    const [rename, remove] = h.calls;
    expect(rename).toMatchObject({
      path: `/${PRODUCT}/devices/dev_other`,
      method: "PATCH",
      authorization: `Bearer ${STALE_TOKEN}`,
      contentType: "application/json",
      body: { label: "Studio Mac" },
    });
    expect(remove).toMatchObject({
      path: `/${PRODUCT}/devices/dev_other`,
      method: "DELETE",
      authorization: `Bearer ${STALE_TOKEN}`,
    });
    // A DELETE carries no body — there is nothing to say beyond the path.
    expect(remove?.body).toBeUndefined();
  });

  it("clears a label with null, and percent-encodes the id into the path", async () => {
    // The id is interpolated into a URL, so it is encoded rather than trusted: a `/` in an id
    // would otherwise address a different route entirely.
    const h = await harness({ respond: ok({}), token: STALE_TOKEN });
    await h.client.devices.rename("dev/../admin", null);
    expect(h.only().path).toBe(`/${PRODUCT}/devices/dev%2F..%2Fadmin`);
    expect(h.only().body).toEqual({ label: null });
  });

  it("both throw without a token, before any request", async () => {
    const h = await harness({ respond: ok({}) });
    await expect(h.client.devices.rename("x", "y")).rejects.toMatchObject({
      code: "device-management-unsupported",
    });
    await expect(h.client.devices.deauthorize("x")).rejects.toMatchObject({
      code: "device-management-unsupported",
    });
    expect(h.calls).toHaveLength(0);
  });

  it("both throw on a non-OK status", async () => {
    const h = await harness({ respond: status(403), token: STALE_TOKEN });
    await expect(h.client.devices.rename("x", "y")).rejects.toThrow(
      "device rename failed: 403",
    );
    await expect(h.client.devices.deauthorize("x")).rejects.toThrow(
      "device deauthorize failed: 403",
    );
  });
});

// @pkey-feature devices.report
describe("devices.report() — best-effort telemetry that can never fail a caller", () => {
  it("POSTs /<p>/devices/report with the bearer and answers true", async () => {
    const h = await harness({ respond: ok({}), token: STALE_TOKEN });
    await expect(h.client.devices.report()).resolves.toBe(true);
    expect(h.only()).toMatchObject({
      path: `/${PRODUCT}/devices/report`,
      method: "POST",
      authorization: `Bearer ${STALE_TOKEN}`,
      contentType: "application/json",
      device: DEVICE,
    });
  });

  it("answers false — never throws — with no token, on a non-OK status, and on a dropped connection", async () => {
    // Telemetry must never be able to fail a sync, so every failure mode collapses to `false`
    // and the caller ignores it.
    const noToken = await harness({ respond: ok({}) });
    await expect(noToken.client.devices.report()).resolves.toBe(false);
    expect(noToken.calls).toHaveLength(0); // …and it does not even ask.

    const refused = await harness({ respond: status(500), token: STALE_TOKEN });
    await expect(refused.client.devices.report()).resolves.toBe(false);

    const offline = await harness({
      respond: () => {
        throw new Error("ENETDOWN");
      },
      token: STALE_TOKEN,
    });
    await expect(offline.client.devices.report()).resolves.toBe(false);
  });
});

// @pkey-feature devices.report devices.facts
describe("devices.report() — the body is built from RE-VERIFIED documents (R4-05)", () => {
  it("reports the decoded config and entitlement values from the cached signed documents", async () => {
    // v1 echoed the on-disk cache back verbatim, so a forged local file authored the one
    // signal that would have revealed the forgery. These maps come from the documents
    // `CacheManager` re-verified against the pins at `init()`, not from the record's bytes.
    const license = await signJws(
      {
        iss: "key.plrs.im",
        aud: PRODUCT,
        deviceId: DEVICE,
        issuedAt: NOW,
        expiresAt: NOW + 3600,
        graceUntil: NOW + 86_400,
        licenseId: "lic_report",
        entitlements: {
          polarisVpn: { state: "enforced", value: true, updatedAt: NOW },
          "license.tier": { state: "enforced", value: "pro", updatedAt: NOW },
        },
      } satisfies LicenseDoc,
      PEM,
      KID,
      "pkey-license+jws",
    );
    const config = await signJws(
      {
        iss: "key.plrs.im",
        aud: PRODUCT,
        deviceId: DEVICE,
        issuedAt: NOW,
        expiresAt: NOW + 3600,
        graceUntil: NOW + 86_400,
        schemaVersion: 7,
        config: {
          "ui.theme": { state: "default", value: "dark", updatedAt: NOW },
          "run.concurrency": { state: "enforced", value: 4, updatedAt: NOW },
        },
        secrets: {
          "proxy.url": {
            state: "hidden",
            value: "https://secret.example",
            updatedAt: NOW,
          },
        },
      } satisfies ConfigDoc,
      PEM,
      KID,
      "pkey-config+jws",
    );

    const h = await harness({
      respond: ok({}),
      token: STALE_TOKEN,
      cache: { v: CACHE_VERSION, docs: { license, config } },
    });
    await expect(h.client.devices.report()).resolves.toBe(true);

    const body = h.only().body!;
    expect(body.config).toEqual({ "ui.theme": "dark", "run.concurrency": 4 });
    expect(body.entitlements).toEqual({
      polarisVpn: true,
      "license.tier": "pro",
    });
    // The management STATE and `updatedAt` are stripped: the report says what this device
    // believes it has, not how the server described it.
    expect(JSON.stringify(body.config)).not.toContain("enforced");
    // Managed secrets are never enumerated, and never reported.
    expect(JSON.stringify(body)).not.toContain("secret.example");
    // Software facts ride the SAME call — no extra round trip for them (§6).
    expect(body.runtime).toMatchObject({ name: "node" });
  });

  it("reports EMPTY maps when nothing verified — an empty report is a truthful one", async () => {
    // A cache holding a document that fails verification is treated as ABSENT, so the report
    // says `{}` rather than echoing bytes no signature stands behind.
    const h = await harness({
      respond: ok({}),
      token: STALE_TOKEN,
      cache: {
        v: CACHE_VERSION,
        docs: { license: "not.a.jws", config: "also.not.jws" },
      },
    });
    expect(h.client.getSyncState().doc).toBeNull();

    await expect(h.client.devices.report()).resolves.toBe(true);
    const body = h.only().body!;
    expect(body.config).toEqual({});
    expect(body.entitlements).toEqual({});
  });
});
