import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  api,
  RELEASE_POLICY_ERROR_MESSAGES,
  releasePolicyMessage,
  SERVICE_ERROR_MESSAGES,
  setCsrf,
  setLoginRedirectForTests,
} from "../src/api.js";

// The api module is the same-origin client for /manage/api/*. These exercise the transport:
// CSRF echo on mutations, Content-Type only with a body, 401 → login redirect, and the typed
// ApiError surface — all against a stubbed fetch so they're network-free.

interface Call {
  url: string;
  init: RequestInit;
}

let calls: Call[] = [];

/** Stub fetch with a per-call responder; records every call for assertions. */
function stubFetch(
  responder: (url: string, init: RequestInit) => Response,
): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      return responder(url, init);
    }),
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  setCsrf("");
  setLoginRedirectForTests(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLoginRedirectForTests();
});

describe("api — request shaping", () => {
  it("GET requests carry no CSRF header and no Content-Type", async () => {
    stubFetch(() => json({ licenses: [] }));
    await api.licenses("djdl");
    const init = calls[0]!.init;
    const headers = init.headers as Headers;
    expect(calls[0]!.url).toBe("/manage/api/products/djdl/license/licenses");
    expect(headers.get("X-PKey-CSRF")).toBeNull();
    expect(headers.get("Content-Type")).toBeNull();
    expect(init.credentials).toBe("same-origin");
  });

  it("a mutation echoes the CSRF token and sets Content-Type when there is a body", async () => {
    setCsrf("tok-123");
    stubFetch(() => json({ licenseId: "l1", key: "k", license: {} }));
    await api.createLicense("djdl", { name: "Ada", email: "a@x.io" });
    const init = calls[0]!.init;
    const headers = init.headers as Headers;
    expect(init.method).toBe("POST");
    expect(headers.get("X-PKey-CSRF")).toBe("tok-123");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "Ada",
      email: "a@x.io",
    });
  });

  it("a mutation with no body still echoes CSRF but omits Content-Type", async () => {
    setCsrf("tok-9");
    stubFetch(() => json({ ok: true }));
    await api.logout();
    const headers = calls[0]!.init.headers as Headers;
    expect(headers.get("X-PKey-CSRF")).toBe("tok-9");
    expect(headers.get("Content-Type")).toBeNull();
  });

  it("URL-encodes path parameters", async () => {
    stubFetch(() => json({}));
    await api.license("djdl", "lic/with space");
    expect(calls[0]!.url).toBe(
      "/manage/api/products/djdl/license/licenses/lic%2Fwith%20space",
    );
  });

  it("builds the activity query string with limit (and cursor when given)", async () => {
    stubFetch(() => json({ items: [], nextCursor: null }));
    await api.activity("djdl", { beforeAt: 123, beforeId: "a1" }, 25);
    const url = calls[0]!.url;
    expect(url).toContain("limit=25");
    expect(url).toContain("beforeAt=123");
    expect(url).toContain("beforeId=a1");
  });

  it("services is a plain GET on the product's services route", async () => {
    setCsrf("tok-s");
    stubFetch(() =>
      json({
        services: { license: { enabled: true }, config: { enabled: false } },
        registration: null,
        effectiveRegistration: "requires-license",
        source: "manifest",
      }),
    );
    const res = await api.services("djdl");
    const init = calls[0]!.init;
    expect(calls[0]!.url).toBe("/manage/api/products/djdl/services");
    expect(init.method).toBeUndefined();
    expect((init.headers as Headers).get("X-PKey-CSRF")).toBeNull();
    expect(res.services.config.enabled).toBe(false);
  });

  it("mintBundle POSTs the exact bundle request with CSRF + Content-Type", async () => {
    setCsrf("tok-b");
    stubFetch(() => json({ bundleId: "01JBUNDLE", bundle: "eyJ.e30.sig" }));
    const deviceId = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
    const res = await api.mintBundle("djdl", {
      deviceId,
      graceDays: 30,
      includeConfig: false,
      licenseId: "lic_1",
    });
    const init = calls[0]!.init;
    const headers = init.headers as Headers;
    expect(calls[0]!.url).toBe("/manage/api/products/djdl/bundles");
    expect(init.method).toBe("POST");
    expect(headers.get("X-PKey-CSRF")).toBe("tok-b");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      deviceId,
      graceDays: 30,
      includeConfig: false,
      licenseId: "lic_1",
    });
    expect(res.bundleId).toBe("01JBUNDLE");
  });

  it("setLicenseEnabled hits enable/disable per the flag", async () => {
    stubFetch(() => json({ ok: true, id: "l1", status: "disabled" }));
    await api.setLicenseEnabled("djdl", "l1", false);
    expect(calls[0]!.url).toBe(
      "/manage/api/products/djdl/license/licenses/l1/disable",
    );
    await api.setLicenseEnabled("djdl", "l1", true);
    expect(calls[1]!.url).toBe(
      "/manage/api/products/djdl/license/licenses/l1/enable",
    );
  });
});

describe("api — error handling", () => {
  it("a 401 redirects to login and throws ApiError(401)", async () => {
    const redirect = vi.fn();
    setLoginRedirectForTests(redirect);
    stubFetch(() => new Response(null, { status: 401 }));
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it("a non-ok JSON error surfaces fields + code + message", async () => {
    stubFetch(() =>
      json(
        { error: "validation", message: "bad input", fields: ["email"] },
        422,
      ),
    );
    try {
      await api.createLicense("djdl", { name: "x", email: "bad" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(422);
      expect(err.code).toBe("validation");
      expect(err.fields).toEqual(["email"]);
      expect(err.message).toBe("bad input");
    }
  });

  it("a non-ok non-JSON error still throws ApiError with the status", async () => {
    stubFetch(() => new Response("upstream boom", { status: 502 }));
    await expect(api.products()).rejects.toMatchObject({ status: 502 });
  });

  it("a successful response is parsed and returned", async () => {
    stubFetch(() => json({ products: [{ slug: "djdl" }] }));
    const res = await api.products();
    expect(res.products[0]!.slug).toBe("djdl");
  });
});

describe("ApiError", () => {
  it("formats its message from the status by default", () => {
    expect(new ApiError(403).message).toBe("api 403");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The service-grouped admin surface (plan §R1)
// ═════════════════════════════════════════════════════════════════════════════

describe("api — every product-scoped resource is under its owning service", () => {
  /**
   * The one place the console's half of §R1 is pinned. The worker deleted the pre-suite
   * spellings outright (pre-launch, this client was their only consumer), so a client method
   * left on an old path is not a soft mismatch that degrades — it is a 404 the operator meets
   * as an empty screen. Asserting the URL of every regrouped call is cheap; discovering one by
   * clicking through the console is not.
   */
  const CASES: [string, () => Promise<unknown>, string][] = [
    ["licenses", () => api.licenses("djdl"), "license/licenses"],
    ["license", () => api.license("djdl", "l1"), "license/licenses/l1"],
    [
      "putLicenseOverrides",
      () => api.putLicenseOverrides("djdl", "l1", []),
      "license/licenses/l1/overrides",
    ],
    [
      "licenseKeys",
      () => api.licenseKeys("djdl", "l1"),
      "license/licenses/l1/keys",
    ],
    ["mintKey", () => api.mintKey("djdl", "l1"), "license/licenses/l1/keys"],
    [
      "revokeKey",
      () => api.revokeKey("djdl", "l1", "h1"),
      "license/licenses/l1/keys/h1/revoke",
    ],
    [
      "licenseDevices",
      () => api.licenseDevices("djdl", "l1"),
      "license/licenses/l1/devices",
    ],
    [
      "deauthorizeDevice",
      () => api.deauthorizeDevice("djdl", "l1", "d1"),
      "license/licenses/l1/devices/d1",
    ],
    [
      "resetDeviceFingerprint",
      () => api.resetDeviceFingerprint("djdl", "l1", "d1"),
      "license/licenses/l1/devices/d1/fingerprint/reset",
    ],
    ["tiers", () => api.tiers("djdl"), "license/tiers"],
    ["createTier", () => api.createTier("djdl", {}), "license/tiers"],
    ["patchTier", () => api.patchTier("djdl", "t1", {}), "license/tiers/t1"],
    ["deleteTier", () => api.deleteTier("djdl", "t1"), "license/tiers/t1"],
    [
      "fingerprintPolicy",
      () => api.fingerprintPolicy("djdl"),
      "license/policy",
    ],
    [
      "updateFingerprintPolicy",
      () => api.updateFingerprintPolicy("djdl", {}),
      "license/policy",
    ],
    [
      "revertFingerprintPolicy",
      () => api.revertFingerprintPolicy("djdl"),
      "license/policy/revert",
    ],
    ["schema", () => api.schema("djdl"), "config/catalog"],
    [
      "publishSchema",
      () => api.publishSchema("djdl", { schemaVersion: 1, entries: [] }),
      "config/catalog",
    ],
    ["profiles", () => api.profiles("djdl"), "config/profiles"],
    ["profile", () => api.profile("djdl", "p1"), "config/profiles/p1"],
    ["createProfile", () => api.createProfile("djdl", {}), "config/profiles"],
    [
      "putProfilePayload",
      () => api.putProfilePayload("djdl", "p1", []),
      "config/profiles/p1",
    ],
    [
      "deleteProfile",
      () => api.deleteProfile("djdl", "p1"),
      "config/profiles/p1",
    ],
    ["portalSettings", () => api.portalSettings("djdl"), "identity/portal"],
    [
      "updatePortalSettings",
      () => api.updatePortalSettings("djdl", {}),
      "identity/portal",
    ],
    ["releaseHealth", () => api.releaseHealth("djdl"), "release/health"],
    ["resyncProduct", () => api.resyncProduct("djdl"), "release/resync"],
    [
      "revertClaim",
      () => api.revertClaim("djdl", "core.name"),
      "claims/core.name",
    ],
    ["releases", () => api.releases("djdl"), "release/releases"],
    ["releaseChannels", () => api.releaseChannels("djdl"), "release/channels"],
    [
      "updateReleaseChannel",
      () => api.updateReleaseChannel("djdl", "stable", { critical: true }),
      "release/channels/stable",
    ],
    [
      "revertReleaseChannel",
      () => api.revertReleaseChannel("djdl", "beta"),
      "release/channels/beta/revert",
    ],
    [
      "setChannelFloor",
      () => api.setChannelFloor("djdl", "stable", { clear: true }),
      "release/channels/stable/floor",
    ],
    [
      "yankRelease",
      () => api.yankRelease("djdl", "v1.0.0", "bad"),
      "release/releases/v1.0.0/yank",
    ],
    [
      "unyankRelease",
      () => api.unyankRelease("djdl", "v1.0.0"),
      "release/releases/v1.0.0/yank",
    ],
    ["updateSettings", () => api.updateSettings("djdl"), "update/settings"],
    ["edgeMintRecipes", () => api.edgeMintRecipes("djdl"), "config/mint"],
    [
      "approveEdgeMintRecipe",
      () =>
        api.approveEdgeMintRecipe(
          "djdl",
          "music",
          {
            alg: "ES256",
            signingKeySecret: "K",
            kid: null,
            claimsTemplateJson: null,
            ttlSeconds: 60,
            audience: null,
          },
          null,
          true,
        ),
      "config/mint/music/approve",
    ],
    [
      "revokeEdgeMintRecipe",
      () => api.revokeEdgeMintRecipe("djdl", "music"),
      "config/mint/music/revoke",
    ],
    [
      "saveUpdateSettings",
      () => api.saveUpdateSettings("djdl", {}),
      "update/settings",
    ],
    [
      "revertUpdateSettings",
      () => api.revertUpdateSettings("djdl", ["access"]),
      "update/settings/revert",
    ],
  ];

  it.each(CASES)("api.%s → %s", async (_name, call, path) => {
    setCsrf("tok");
    stubFetch(() => json({}));
    await call();
    expect(calls[0]!.url).toBe(`/manage/api/products/djdl/${path}`);
  });

  /** Core/platform resources belong to no service and keep their top-level spelling. */
  const PLATFORM: [string, () => Promise<unknown>, string][] = [
    ["services", () => api.services("djdl"), "services"],
    ["updateServices", () => api.updateServices("djdl", {}), "services"],
    ["revertServices", () => api.revertServices("djdl"), "services/revert"],
    [
      "putProductSecret",
      () => api.putProductSecret("djdl", "S", "v"),
      "secrets/S",
    ],
    ["rotateProductKey", () => api.rotateProductKey("djdl"), "keys/rotate"],
    [
      "outletCredentials",
      () => api.outletCredentials("djdl"),
      "outlet-credentials",
    ],
    [
      "putOutletCredential",
      () =>
        api.putOutletCredential("djdl", "asc", {
          kind: "asc-webhook-secret",
          value: { secret: "s" },
        }),
      "outlet-credentials/asc",
    ],
    [
      "deleteOutletCredential",
      () => api.deleteOutletCredential("djdl", "asc"),
      "outlet-credentials/asc",
    ],
    [
      "mintBundle",
      () =>
        api.mintBundle("djdl", {
          deviceId: "AbCdEfGhIjKlMnOpQrStUvWxYz012345",
          graceDays: 1,
        }),
      "bundles",
    ],
  ];

  it.each(PLATFORM)(
    "api.%s stays at the top level → %s",
    async (_name, call, path) => {
      setCsrf("tok");
      stubFetch(() => json({}));
      await call();
      expect(calls[0]!.url).toBe(`/manage/api/products/djdl/${path}`);
    },
  );

  it("putProductSecret sends usage only when one is chosen (P0-12)", async () => {
    setCsrf("tok");
    stubFetch(() => json({ ok: true, name: "S" }));
    await api.putProductSecret("djdl", "S", "v");
    await api.putProductSecret("djdl", "S", "v", "edge-mint");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ value: "v" });
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
      value: "v",
      usage: "edge-mint",
    });
  });

  it("approveEdgeMintRecipe echoes every field, the sign-in trust and License, and the acknowledgement only when given (P0-12)", async () => {
    setCsrf("tok");
    stubFetch(() => json({ ok: true }));
    const fields = {
      alg: "ES256",
      signingKeySecret: "K",
      kid: "k1",
      claimsTemplateJson: '{"iss":"T"}',
      ttlSeconds: 3600,
      audience: null,
    };
    const identity = {
      provider: "custom",
      issuer: "https://id.example",
      clientId: "c",
      groupRoleMapJson: "{}",
    };
    await api.approveEdgeMintRecipe("djdl", "music", fields, null, true);
    await api.approveEdgeMintRecipe(
      "djdl",
      "music",
      fields,
      identity,
      false,
      true,
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      ...fields,
      identity: null,
      licenseEnabled: true,
    });
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
      ...fields,
      identity,
      licenseEnabled: false,
      acknowledgeOpenRegistration: true,
    });
  });

  it("services mutations send the right method and echo CSRF", async () => {
    setCsrf("tok-p");
    stubFetch(() => json({}));
    await api.updateServices("djdl", {
      services: { update: { enabled: true } },
    });
    expect(calls[0]!.init.method).toBe("PATCH");
    expect((calls[0]!.init.headers as Headers).get("X-PKey-CSRF")).toBe(
      "tok-p",
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      services: { update: { enabled: true } },
    });

    await api.revertServices("djdl");
    expect(calls[1]!.init.method).toBe("POST");
  });

  it("surfaces the services endpoint's coherence codes as ApiError.errors", async () => {
    // `errors` is not `fields`: these name a RELATIONSHIP between inputs that are individually
    // valid, which is why the Services editor renders them beside the toggle that created the
    // contradiction instead of beside a field that failed to parse.
    stubFetch(() =>
      json(
        {
          error: {
            code: "bad_request",
            message: "incoherent services",
            errors: ["update_requires_distribution"],
          },
          code: "bad_request",
          message: "incoherent services",
          errors: ["update_requires_distribution"],
        },
        422,
      ),
    );
    try {
      await api.updateServices("djdl", {
        services: { update: { enabled: true } },
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(422);
      expect(err.errors).toEqual(["update_requires_distribution"]);
      expect(err.fields).toBeUndefined();
      expect(SERVICE_ERROR_MESSAGES[err.errors![0]!]).toContain("Distribution");
    }
  });
});

describe("api — release channel policy (P2-07)", () => {
  it("sends each P2-05 admin operation with its method and body", async () => {
    setCsrf("tok");
    stubFetch(() => json({ ok: true }));
    await api.updateReleaseChannel("diceroll", "stable", {
      deliverable: "app",
      pointer: "v0.4.2",
      pinned: true,
    });
    await api.revertReleaseChannel("diceroll", "beta", "app");
    await api.revertReleaseChannel("diceroll", "beta");
    await api.setChannelFloor("diceroll", "stable", { version: "0.4.1" });
    await api.yankRelease("diceroll", "v0.4.2", "crashes");
    await api.unyankRelease("diceroll", "v0.4.2");
    const seen = calls.map((c) => [
      c.init.method,
      c.url.replace("/manage/api/products/diceroll/release/", ""),
      c.init.body === undefined ? undefined : JSON.parse(c.init.body as string),
    ]);
    expect(seen).toEqual([
      [
        "PUT",
        "channels/stable",
        { deliverable: "app", pointer: "v0.4.2", pinned: true },
      ],
      ["POST", "channels/beta/revert", { deliverable: "app" }],
      ["POST", "channels/beta/revert", {}],
      ["POST", "channels/stable/floor", { version: "0.4.1" }],
      ["POST", "releases/v0.4.2/yank", { reason: "crashes" }],
      ["DELETE", "releases/v0.4.2/yank", undefined],
    ]);
    // Every one is a mutation, so every one echoes the CSRF token.
    for (const c of calls)
      expect((c.init.headers as Headers).get("X-PKey-CSRF")).toBe("tok");
  });

  it("encodes a release id or channel segment", async () => {
    setCsrf("tok");
    stubFetch(() => json({ ok: true }));
    await api.yankRelease("diceroll", "app@1.0.0+build/1", "x");
    expect(calls[0]!.url).toBe(
      "/manage/api/products/diceroll/release/releases/app%401.0.0%2Bbuild%2F1/yank",
    );
  });

  it("carries the refusal reason the policy routes send, and words it from one table", async () => {
    setCsrf("tok");
    // The admin error shape: nested and flat copies of code/message/extra (worker respond.ts).
    stubFetch(() =>
      json(
        {
          error: {
            code: "bad_request",
            message: "a yanked release cannot be promoted",
            reason: "release_yanked",
            fields: ["releaseId"],
          },
          code: "bad_request",
          message: "a yanked release cannot be promoted",
          reason: "release_yanked",
          fields: ["releaseId"],
        },
        409,
      ),
    );
    const err = await api
      .updateReleaseChannel("diceroll", "stable", { pointer: "v0.4.0" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).reason).toBe("release_yanked");
    expect((err as ApiError).fields).toEqual(["releaseId"]);
    expect(releasePolicyMessage(err)).toBe(
      RELEASE_POLICY_ERROR_MESSAGES.release_yanked,
    );
  });

  it("falls back to the server's message for a reason the table does not know", () => {
    const err = new ApiError(422, ["version"], "bad_request", undefined);
    err.message = "a floor can only be lowered; the sync raises it";
    expect(releasePolicyMessage(err)).toBe(
      "a floor can only be lowered; the sync raises it",
    );
    expect(releasePolicyMessage(new ApiError(500))).toBe(
      "Request failed (500).",
    );
  });
});
