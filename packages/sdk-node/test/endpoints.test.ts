// The License service's HTTP surface — wire contract v3 §5 (`POST /<p>/license/*`) and §6
// (`POST /<p>/devices/report`).
//
// These are the pins on the TRANSPORT, and only the transport. `src/license/endpoints.ts` is
// deliberately verification-free: it builds a request, reads a status, and hands back bytes.
// What this file protects is therefore the two things a caller cannot recover if they are
// wrong — WHERE the request went and WHAT the status meant.
//
// ── WHY THE ROUTES ARE ASSERTED LITERALLY ───────────────────────────────────────────────────
//
// v3 moved every licensing verb under `/<p>/license/` and relocated telemetry from
// `POST /<p>/config/report` to `POST /<p>/devices/report` (§6 — it was licence anti-fraud data
// living under a config path, and a config-only product reports too). A path typo does not fail
// loudly: it 404s, `activationLike` maps 404 to `enroll-disabled`, and the operator is told
// their product does not offer keyless enrollment. Spelling the URLs out here is what keeps
// that from being a silent regression.
//
// ── WHY BOTH ERROR-BODY SHAPES ──────────────────────────────────────────────────────────────
//
// v3 nests the machine-readable code (`{"error":{"code":…}}`); older/simpler servers answer the
// flat shape (`{limit,deviceCount}` / `{"error":"fingerprint_required"}`). A 403 that means
// "device limit" and a 403 that means "fingerprint required" are DIFFERENT operator outcomes,
// and guessing between them would be worse than either — so both encodings are pinned for both.
//
// ── WHY THE HEADERS AND THE DEADLINE ARE PINNED PER VERB ────────────────────────────────────
//
// R4-08: Node's `fetch` has no default timeout, so a slowloris on any endpoint stalls `sync()`
// forever. Both the seven `X-PKey-*` metadata headers and the deadline come from
// `CoreContext`, and the table at the bottom asserts EVERY verb goes through it — a new
// endpoint that assembled its own headers would fail here rather than in production.

import { describe, expect, it } from "vitest";
import { arch, platform } from "node:os";
import type { HardwareFingerprint } from "@polaris-key/protocol/core";
import { CoreContext } from "../src/core/context.js";
import { InMemoryStore } from "../src/core/store.js";
import {
  activateWithKey,
  deauthorize,
  enroll,
  reacquireToken,
} from "../src/license/endpoints.js";
import { reportSnapshot } from "../src/core/telemetry.js";
import { SDK_VERSION } from "../src/version.js";
import { canonicalArch, canonicalPlatform } from "@polaris-key/client-core";

/** One canned response. `text` (rather than `json`) is how the malformed-body pins are fed. */
interface Canned {
  status: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

/** A fake fetch returning canned Responses in order + capturing the requests. */
function fakeFetch(responses: Canned[]): {
  impl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const impl = (async (url: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    const body =
      r.text !== undefined
        ? r.text
        : r.json === undefined
          ? null
          : JSON.stringify(r.json);
    return new Response(r.status === 304 ? null : body, {
      status: r.status,
      headers: r.headers,
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** A transport that always fails, for the "returns error, never throws" pins. */
function explodingFetch(message = "ECONNREFUSED"): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

/**
 * A ready-to-use Core. `init()` is what loads the device id off the store, so it must run
 * before any endpoint call — an un-`init()`ed context sends an empty `X-PKey-Device`.
 */
async function makeCtx(impl: typeof fetch): Promise<CoreContext> {
  const ctx = new CoreContext({
    productSlug: "djdl",
    baseUrl: "https://k.test",
    version: "1.2.3",
    trust: { pinnedKeys: {} },
    store: new InMemoryStore("djdl"),
    fetchImpl: impl,
    // PX-W13: a fixed device label, so request bodies do not depend on the host name.
    deviceName: "Test Device",
  });
  await ctx.init();
  return ctx;
}

const headersOf = (init: RequestInit): Headers => new Headers(init.headers);

/** A synthetic fingerprint: the endpoint only ever passes it through, so the values are inert. */
const FINGERPRINT: HardwareFingerprint = {
  components: { machineUuid: "mu-hash", cpuModel: "cpu-hash" },
  hwid: "hwid-hash",
};

// @pkey-feature license.activate
describe("activateWithKey — POST /<p>/license/activate", () => {
  it("POSTs the v3 route with Bearer <key> + the device header and returns the minted token", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, json: { token: "pkeyt_minted", schemaVersion: 3 } },
    ]);
    const ctx = await makeCtx(impl);
    const res = await activateWithKey(ctx, "pkey_djdl_AAA", null);

    expect(res).toEqual({
      kind: "ok",
      token: "pkeyt_minted",
      schemaVersion: 3,
    });
    // The route moved under `/license/` in v3; the old `/djdl/activate` now 404s.
    expect(calls[0]?.url).toBe("https://k.test/djdl/license/activate");
    expect(calls[0]?.init.method).toBe("POST");
    const h = headersOf(calls[0]!.init);
    // The KEY is the bearer here — the `pkeyt_` device token does not exist yet.
    expect(h.get("authorization")).toBe("Bearer pkey_djdl_AAA");
    expect(h.get("x-pkey-device")).toBe(ctx.deviceId);
  });

  it("sends the fingerprint as a JSON body when the host produced one", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, json: { token: "pkeyt_minted", schemaVersion: 3 } },
    ]);
    const ctx = await makeCtx(impl);
    await activateWithKey(ctx, "pkey_djdl_AAA", FINGERPRINT);

    expect(headersOf(calls[0]!.init).get("content-type")).toBe(
      "application/json",
    );
    // PX-W13 §8 Q2: the device label rides along on activation.
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      fingerprint: FINGERPRINT,
      deviceName: "Test Device",
    });
  });

  it("surfaces a 403 device-limit distinctly with limit + count (flat body)", async () => {
    const { impl } = fakeFetch([
      { status: 403, json: { limit: 3, deviceCount: 3 } },
    ]);
    expect(
      await activateWithKey(await makeCtx(impl), "pkey_djdl_AAA", null),
    ).toEqual({
      kind: "device-limit",
      code: "device_limit",
      limit: 3,
      deviceCount: 3,
    });
  });

  it("reads the same device-limit out of the v3 NESTED error body", async () => {
    // `{"error":{"code":"device_limit","limit":3,"deviceCount":3}}` — the shape the Worker
    // actually emits (§5 / PolarisErrorBody). Both encodings must land on one outcome.
    const { impl } = fakeFetch([
      {
        status: 403,
        json: { error: { code: "device_limit", limit: 3, deviceCount: 3 } },
      },
    ]);
    expect(
      await activateWithKey(await makeCtx(impl), "pkey_djdl_AAA", null),
    ).toEqual({
      kind: "device-limit",
      code: "device_limit",
      limit: 3,
      deviceCount: 3,
    });
  });

  // @pkey-feature license.manage
  // PX-W8: the refusal link rides on device-limit; an invalid one is dropped, and an unknown
  // member never changes the outcome.
  it("surfaces manageUrl on device-limit, flat or nested, and drops an invalid one", async () => {
    const url =
      "https://key.plrs.im/activate?product=djdl&next=free-device&for=Linux%20x86_64";
    for (const body of [
      { error: "device_limit", limit: 1, deviceCount: 1, manageUrl: url },
      {
        error: {
          code: "device_limit",
          limit: 1,
          deviceCount: 1,
          manageUrl: url,
        },
      },
    ]) {
      const { impl } = fakeFetch([{ status: 403, json: body }]);
      expect(
        await activateWithKey(await makeCtx(impl), "pkey_djdl_AAA", null),
      ).toEqual({
        kind: "device-limit",
        code: "device_limit",
        limit: 1,
        deviceCount: 1,
        manageUrl: url,
      });
    }
    const { impl } = fakeFetch([
      {
        status: 403,
        json: {
          error: "device_limit",
          limit: 1,
          deviceCount: 1,
          manageUrl: "javascript:alert(1)",
          somethingNew: true,
        },
      },
    ]);
    expect(
      await activateWithKey(await makeCtx(impl), "pkey_djdl_AAA", null),
    ).toEqual({
      kind: "device-limit",
      code: "device_limit",
      limit: 1,
      deviceCount: 1,
    });
  });

  it("distinguishes fingerprint_required from device-limit (flat body)", async () => {
    const { impl } = fakeFetch([
      { status: 403, json: { error: "fingerprint_required" } },
    ]);
    expect(
      (await activateWithKey(await makeCtx(impl), "pkey_djdl_AAA", null)).kind,
    ).toBe("fingerprint-required");
  });

  it("distinguishes fingerprint_required from device-limit (nested body)", async () => {
    const { impl } = fakeFetch([
      { status: 403, json: { error: { code: "fingerprint_required" } } },
    ]);
    expect(
      (await activateWithKey(await makeCtx(impl), "pkey_djdl_AAA", null)).kind,
    ).toBe("fingerprint-required");
  });

  it("reports a 403 that names no code as refused{forbidden}, never as a device limit", async () => {
    // SDK parity pass §3.1: the mapping goes by the body's code, never by the status alone. An
    // unexplained 403 told the operator to free a seat, which is a remedy for a different cause.
    const { impl } = fakeFetch([{ status: 403, text: "not json" }]);
    expect(
      await activateWithKey(await makeCtx(impl), "pkey_djdl_AAA", null),
    ).toEqual({
      kind: "refused",
      code: "forbidden",
      status: 403,
      message: "",
    });
  });

  it("maps a 409 to hardware-mismatch with drift + changed (flat body)", async () => {
    // §5: the tier's drift tolerance was exceeded and the binding was RETIRED. Re-running
    // activation re-binds and consumes a seat, which is why the caller must be told which
    // components moved rather than just "forbidden".
    const { impl } = fakeFetch([
      { status: 409, json: { drift: 3, changed: ["primaryMac", "cpuModel"] } },
    ]);
    expect(
      await activateWithKey(await makeCtx(impl), "pkey_djdl_AAA", null),
    ).toEqual({
      kind: "hardware-mismatch",
      code: "hardware_mismatch",
      drift: 3,
      changed: ["primaryMac", "cpuModel"],
    });
  });

  it("maps a 409 to hardware-mismatch with drift + changed (nested body)", async () => {
    const { impl } = fakeFetch([
      {
        status: 409,
        json: {
          error: {
            code: "hardware_mismatch",
            drift: 1,
            changed: ["boardSerial"],
          },
        },
      },
    ]);
    expect(
      await activateWithKey(await makeCtx(impl), "pkey_djdl_AAA", null),
    ).toEqual({
      kind: "hardware-mismatch",
      code: "hardware_mismatch",
      drift: 1,
      changed: ["boardSerial"],
    });
  });

  it("maps a 401 to unauthorized (bad/revoked key)", async () => {
    const { impl } = fakeFetch([{ status: 401 }]);
    expect(
      (await activateWithKey(await makeCtx(impl), "pkey_bad", null)).kind,
    ).toBe("unauthorized");
  });

  it("maps enroll_disabled by its code, and a codeless 404 to refused{not_found}", async () => {
    // A path typo 404s with no code; reporting it as "keyless enrollment is off" would send the
    // operator after the wrong setting, so only the Worker's own code maps to enroll-disabled.
    const coded = fakeFetch([
      { status: 404, json: { error: "enroll_disabled" } },
    ]);
    expect(
      (await activateWithKey(await makeCtx(coded.impl), "pkey_djdl_AAA", null))
        .kind,
    ).toBe("enroll-disabled");
    const bare = fakeFetch([{ status: 404 }]);
    expect(
      await activateWithKey(await makeCtx(bare.impl), "pkey_djdl_AAA", null),
    ).toMatchObject({ kind: "refused", code: "not_found", status: 404 });
  });

  it("maps other failures to error with the body message", async () => {
    const { impl } = fakeFetch([{ status: 500, text: "boom" }]);
    const res = await activateWithKey(await makeCtx(impl), "pkey_x", null);
    expect(res.kind).toBe("error");
    expect(res).toMatchObject({ message: "boom" });
  });

  it("returns error (not throw) on a network failure", async () => {
    const res = await activateWithKey(
      await makeCtx(explodingFetch()),
      "pkey_x",
      null,
    );
    expect(res).toEqual({
      kind: "error",
      code: "network",
      message: "ECONNREFUSED",
    });
  });
});

// @pkey-feature license.enroll
describe("enroll — POST /<p>/license/enroll", () => {
  it("POSTs the enroll route with NO Authorization header", async () => {
    // The whole point of §5's keyless tier: there is no credential to present. An
    // `Authorization` header here would make an unauthenticated mint look authenticated.
    const { impl, calls } = fakeFetch([
      { status: 200, json: { token: "pkeyt_free", schemaVersion: 3 } },
    ]);
    const ctx = await makeCtx(impl);
    const res = await enroll(ctx, null);

    expect(res).toEqual({ kind: "ok", token: "pkeyt_free", schemaVersion: 3 });
    expect(calls[0]?.url).toBe("https://k.test/djdl/license/enroll");
    expect(calls[0]?.init.method).toBe("POST");
    const h = headersOf(calls[0]!.init);
    expect(h.get("authorization")).toBeNull();
    expect(h.get("x-pkey-device")).toBe(ctx.deviceId);
  });

  it("sends a fingerprint body only when one is given", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, json: { token: "pkeyt_free", schemaVersion: 3 } },
    ]);
    const ctx = await makeCtx(impl);
    await enroll(ctx, FINGERPRINT);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      fingerprint: FINGERPRINT,
    });
  });

  it("omits the body ENTIRELY for a null fingerprint (not an empty object)", async () => {
    // A host that opted out must send a byte-identical request to one that had nothing to
    // report — `{"fingerprint":null}` would be a distinguishable "I refused" signal.
    const { impl, calls } = fakeFetch([
      { status: 200, json: { token: "pkeyt_free", schemaVersion: 3 } },
    ]);
    await enroll(await makeCtx(impl), null);
    expect(calls[0]!.init.body).toBeUndefined();
    expect(headersOf(calls[0]!.init).get("content-type")).toBeNull();
  });

  it("maps a 404 enroll_disabled to enroll-disabled (the product never opted in)", async () => {
    const { impl } = fakeFetch([
      { status: 404, json: { error: "enroll_disabled" } },
    ]);
    expect((await enroll(await makeCtx(impl), null)).kind).toBe(
      "enroll-disabled",
    );
  });

  it("returns error (not throw) on a network failure", async () => {
    expect((await enroll(await makeCtx(explodingFetch()), null)).kind).toBe(
      "error",
    );
  });
});

describe("reacquireToken — POST /<p>/license/token", () => {
  it("POSTs the token route with the CURRENT bearer + device header", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, json: { token: "pkeyt_reacquired", schemaVersion: 3 } },
    ]);
    const ctx = await makeCtx(impl);
    const res = await reacquireToken(ctx, "pkeyt_current");

    expect(res).toEqual({
      kind: "ok",
      token: "pkeyt_reacquired",
      schemaVersion: 3,
    });
    expect(calls[0]?.url).toBe("https://k.test/djdl/license/token");
    expect(calls[0]?.init.method).toBe("POST");
    const h = headersOf(calls[0]!.init);
    expect(h.get("authorization")).toBe("Bearer pkeyt_current");
    expect(h.get("x-pkey-device")).toBe(ctx.deviceId);
    // Rotation re-presents the credential; it never re-presents hardware.
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it("maps 403 to device-limit", async () => {
    const { impl } = fakeFetch([
      { status: 403, json: { limit: 2, deviceCount: 2 } },
    ]);
    expect(
      (await reacquireToken(await makeCtx(impl), "pkeyt_current")).kind,
    ).toBe("device-limit");
  });

  it("maps 401 to unauthorized", async () => {
    const { impl } = fakeFetch([{ status: 401 }]);
    expect(
      (await reacquireToken(await makeCtx(impl), "pkeyt_current")).kind,
    ).toBe("unauthorized");
  });

  it("returns error on a network failure", async () => {
    expect(
      (
        await reacquireToken(
          await makeCtx(explodingFetch("offline")),
          "pkeyt_current",
        )
      ).kind,
    ).toBe("error");
  });
});

// @pkey-feature license.deactivate
describe("deauthorize — POST /<p>/license/deauthorize", () => {
  it("POSTs the deauthorize route with the token bearer", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, json: { ok: true } }]);
    await deauthorize(await makeCtx(impl), "pkeyt_x");

    expect(calls[0]?.url).toBe("https://k.test/djdl/license/deauthorize");
    expect(calls[0]?.init.method).toBe("POST");
    expect(headersOf(calls[0]!.init).get("authorization")).toBe(
      "Bearer pkeyt_x",
    );
  });

  it("is best-effort: swallows a network failure", async () => {
    // The LOCAL wipe is what `deactivate()` actually depends on. A device deauthorizing on a
    // plane must not be left holding credentials because the control plane was unreachable.
    await expect(
      deauthorize(await makeCtx(explodingFetch()), "pkeyt_x"),
    ).resolves.toBeUndefined();
  });

  it("swallows a non-OK response too (no throw)", async () => {
    const { impl } = fakeFetch([{ status: 401 }]);
    await expect(
      deauthorize(await makeCtx(impl), "pkeyt_x"),
    ).resolves.toBeUndefined();
  });
});

// @pkey-feature devices.report
describe("reportSnapshot — POST /<p>/devices/report", () => {
  it("POSTs the JSON snapshot to the DEVICES route, not the retired /config/report", async () => {
    // §6: telemetry moved off the config service. It is licence anti-fraud data that had been
    // living under a config path, and a config-only product reports on it too.
    const { impl, calls } = fakeFetch([{ status: 200, json: {} }]);
    const ok = await reportSnapshot(await makeCtx(impl), "pkeyt_x", {
      config: { a: 1 },
      entitlements: {},
    });

    expect(ok).toBe(true);
    expect(calls[0]?.url).toBe("https://k.test/djdl/devices/report");
    expect(calls[0]?.init.method).toBe("POST");
    const h = headersOf(calls[0]!.init);
    expect(h.get("authorization")).toBe("Bearer pkeyt_x");
    expect(h.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      config: { a: 1 },
      entitlements: {},
    });
  });

  it("returns false on a non-OK response", async () => {
    const { impl } = fakeFetch([{ status: 500 }]);
    expect(await reportSnapshot(await makeCtx(impl), "pkeyt_x", {})).toBe(
      false,
    );
  });

  it("swallows a network failure and returns false (best-effort)", async () => {
    expect(
      await reportSnapshot(
        await makeCtx(explodingFetch("offline")),
        "pkeyt_x",
        {},
      ),
    ).toBe(false);
  });
});

// @pkey-feature core.headers
describe("every call carries the Core metadata headers + a deadline (R4-08)", () => {
  /** The seven `X-PKey-*` headers §5 requires on every product-scoped request. */
  const METADATA_HEADERS = [
    "x-pkey-device",
    "x-pkey-version",
    "x-pkey-channel",
    "x-pkey-platform",
    "x-pkey-arch",
    "x-pkey-sdk",
    "x-pkey-sdk-version",
  ] as const;

  const VERBS: Array<[string, (ctx: CoreContext) => Promise<unknown>]> = [
    ["activate", (ctx) => activateWithKey(ctx, "pkey_djdl_AAA", null)],
    ["enroll", (ctx) => enroll(ctx, null)],
    ["token", (ctx) => reacquireToken(ctx, "pkeyt_current")],
    ["deauthorize", (ctx) => deauthorize(ctx, "pkeyt_x")],
    ["report", (ctx) => reportSnapshot(ctx, "pkeyt_x", {})],
  ];

  it.each(VERBS)(
    "%s sends all seven X-PKey-* headers with the right values",
    async (_name, call) => {
      const { impl, calls } = fakeFetch([
        { status: 200, json: { token: "pkeyt_t", schemaVersion: 3 } },
      ]);
      const ctx = await makeCtx(impl);
      await call(ctx);

      const h = headersOf(calls[0]!.init);
      for (const name of METADATA_HEADERS) expect(h.get(name)).toBeTruthy();
      expect(h.get("x-pkey-device")).toBe(ctx.deviceId);
      expect(h.get("x-pkey-version")).toBe("1.2.3");
      // Derived from the host version when the caller names no channel.
      expect(h.get("x-pkey-channel")).toBe("stable");
      // The canonical WIRE-CONTRACT-V3 §5.2 values (every CI host maps both), and the short
      // SDK id rather than the package name.
      expect(canonicalPlatform(platform())).not.toBeNull();
      expect(canonicalArch(arch())).not.toBeNull();
      expect(h.get("x-pkey-platform")).toBe(canonicalPlatform(platform()));
      expect(h.get("x-pkey-arch")).toBe(canonicalArch(arch()));
      expect(h.get("x-pkey-sdk")).toBe("node");
      expect(h.get("x-pkey-sdk-version")).toBe(SDK_VERSION);
    },
  );

  it.each(VERBS)("%s forwards an AbortSignal deadline", async (_name, call) => {
    // Node's `fetch` has NO default timeout: without this a slowloris on any one endpoint
    // stalls `sync()` forever. The signal comes from `CoreContext.deadline()`, so a new
    // endpoint cannot ship without one.
    const { impl, calls } = fakeFetch([
      { status: 200, json: { token: "pkeyt_t", schemaVersion: 3 } },
    ]);
    await call(await makeCtx(impl));
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });
});
