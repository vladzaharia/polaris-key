// @pkey-feature identity.exchange
import { describe, expect, it, vi } from "vitest";
import {
  FEDCM_TIMEOUT_MS,
  GOOGLE_FEDCM_CONFIG_URL,
  fedcmPreventSilentAccess,
  fedcmSignIn,
  type CredentialsLike,
} from "../src/browser/platformIdentity/fedcm.js";

const b64u = (o: unknown) =>
  btoa(JSON.stringify(o))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
const jwt = (claims: unknown) =>
  `${b64u({ alg: "RS256" })}.${b64u(claims)}.sig`;
const base = {
  clientId: "cid.apps.example",
  nonce: "n-1",
  hasIdentityCredential: true,
};

describe("fedcmSignIn", () => {
  it("returns the token and its nonce binding, sending the nonce both ways", async () => {
    const token = jwt({ nonce: "n-1" });
    const get = vi.fn(async (_o: unknown) => ({ token }));
    const r = await fedcmSignIn({ ...base, credentials: { get } });
    expect(r).toEqual({ status: "token", token, nonce: "n-1" });
    const arg = get.mock.calls[0]![0] as any;
    expect(arg.mediation).toBe("silent");
    expect(arg.identity.providers[0]).toMatchObject({
      configURL: GOOGLE_FEDCM_CONFIG_URL,
      clientId: "cid.apps.example",
      nonce: "n-1",
      params: { nonce: "n-1" },
    });
  });

  it("refuses a token whose nonce is not ours, or absent", async () => {
    for (const claims of [{ nonce: "other" }, {}]) {
      const r = await fedcmSignIn({
        ...base,
        credentials: { get: async () => ({ token: jwt(claims) }) },
      });
      expect(r).toEqual({ status: "nonce-mismatch" });
    }
    const bad = await fedcmSignIn({
      ...base,
      credentials: { get: async () => ({ token: "not-a-jwt" }) },
    });
    expect(bad).toEqual({ status: "nonce-mismatch" });
  });

  it("times out through the abort signal", async () => {
    const get = (o: any) =>
      new Promise((_, rej) =>
        o.signal.addEventListener("abort", () =>
          rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
        ),
      );
    const r = await fedcmSignIn({
      ...base,
      credentials: { get },
      timeoutMs: 10,
    });
    expect(r).toEqual({ status: "timeout" });
    expect(FEDCM_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("maps a user cancel and an empty silent answer to cancelled", async () => {
    const denied = Object.assign(new Error("no"), { name: "NotAllowedError" });
    expect(
      await fedcmSignIn({
        ...base,
        credentials: { get: async () => Promise.reject(denied) },
      }),
    ).toEqual({ status: "cancelled" });
    expect(
      await fedcmSignIn({ ...base, credentials: { get: async () => null } }),
    ).toEqual({
      status: "cancelled",
    });
  });

  it("reports unavailable without IdentityCredential and never calls get", async () => {
    const get = vi.fn();
    const r = await fedcmSignIn({
      ...base,
      hasIdentityCredential: false,
      credentials: { get },
    });
    expect(r).toEqual({
      status: "unavailable",
      reason: "no-identity-credential",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("reports other failures as error", async () => {
    const r = await fedcmSignIn({
      ...base,
      credentials: { get: async () => Promise.reject(new Error("boom")) },
    });
    expect(r).toEqual({ status: "error", message: "boom" });
  });
});

describe("fedcmPreventSilentAccess", () => {
  it("calls preventSilentAccess and swallows a refusal", async () => {
    const prevent = vi.fn(async () => undefined);
    await fedcmPreventSilentAccess({
      get: vi.fn(),
      preventSilentAccess: prevent,
    } as CredentialsLike);
    expect(prevent).toHaveBeenCalledOnce();
    await expect(
      fedcmPreventSilentAccess({
        get: vi.fn(),
        preventSilentAccess: async () => Promise.reject(new Error("x")),
      }),
    ).resolves.toBeUndefined();
    await expect(
      fedcmPreventSilentAccess({ get: vi.fn() }),
    ).resolves.toBeUndefined();
  });
});
