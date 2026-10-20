import { describe, expect, it } from "vitest";
import {
  relatedOriginsResponse,
  relatedOrigins,
} from "../src/core/customerHost.js";
import { passkeyRelyingParty } from "../src/services/identity/passkeys/webauthn.js";
import type { Env } from "../src/platform/env.js";

const base = { CONSOLE_ORIGIN: "https://key.plrs.im" } as unknown as Env;
const on = {
  ...base,
  CUSTOMER_ORIGIN: "https://polaris.locker",
} as unknown as Env;
const get = (url: string, method = "GET") => new Request(url, { method });

describe("LK-05 related origins", () => {
  it("lists the customer origin only while it is usable", async () => {
    const res = relatedOriginsResponse(
      get("https://key.plrs.im/.well-known/webauthn"),
      on,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ origins: ["https://polaris.locker"] });
    expect(
      relatedOriginsResponse(
        get("https://key.plrs.im/.well-known/webauthn"),
        base,
      ).status,
    ).toBe(404);
    // Naming the console host is not a usable customer host.
    expect(
      relatedOrigins({
        ...base,
        CUSTOMER_ORIGIN: "https://key.plrs.im",
      } as unknown as Env),
    ).toBeNull();
    expect(
      relatedOriginsResponse(
        get("https://key.plrs.im/.well-known/webauthn", "POST"),
        on,
      ).status,
    ).toBe(405);
  });

  it("the relying party keeps the console RP id and pins the origin list", () => {
    const rp = passkeyRelyingParty(on, get("https://polaris.locker/api/x"))!;
    expect(rp).toMatchObject({
      id: "key.plrs.im",
      origin: "https://polaris.locker",
      origins: ["https://key.plrs.im", "https://polaris.locker"],
      name: "Polaris Locker",
    });
    expect(
      passkeyRelyingParty(base, get("https://polaris.locker/x")),
    ).toBeNull();
    expect(passkeyRelyingParty(on, get("https://evil.example/x"))).toBeNull();
    const own = passkeyRelyingParty(base, get("https://key.plrs.im/x"))!;
    expect(own).toMatchObject({
      origins: ["https://key.plrs.im"],
      name: "Polaris Key",
    });
  });

  it("refuses a trailing-dot or case variant of the customer origin", () => {
    for (const url of [
      "https://polaris.locker./api/x",
      "https://POLARIS.LOCKER/api/x",
      "https://polaris.locker:8443/api/x",
      "http://polaris.locker/api/x",
    ]) {
      const rp = passkeyRelyingParty(on, get(url));
      // The URL parser lowercases the host, so only the exact origin passes.
      if (new URL(url).origin === "https://polaris.locker")
        expect(rp?.origin).toBe("https://polaris.locker");
      else expect(rp, url).toBeNull();
    }
  });
});
