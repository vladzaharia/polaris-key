// I-13.3 (CC-01 §0 C1, §2.2; WIRE-CONTRACT-V5 §12.11.3): the native Google and Apple verifiers,
// against fixture tokens signed by a local key. No call leaves the process.

import { beforeEach, describe, expect, it } from "vitest";
import {
  makeProviderHarness,
  nowSec,
  googleClaims,
  appleClaims,
  GOOGLE_CLIENT_ID,
  APPLE_SERVICES_ID,
  type ProviderHarness,
} from "../../identityProviderHarness.js";
import {
  nativeProviderOf,
  verifyNativeToken,
} from "../../../src/services/identity/providers/native.js";
import {
  discoverProvider,
  verifyProviderIdToken,
} from "../../../src/services/identity/providers/discovery.js";
import { OidcVerifyError } from "../../../src/core/oidc/client.js";
import type { PlatformSignInAudiences } from "../../../src/services/identity/platformSignIn.js";

const WEB = "1234-web.apps.googleusercontent.com";
const AND = "1234-and.apps.googleusercontent.com";
const NONCE = "n".repeat(43);
const BUNDLE = "com.acme.mac";
const OUTLET_BUNDLE = "com.acme.ios";

const AUD: PlatformSignInAudiences = {
  google: { serverClientId: WEB, clientIds: [AND] },
  apple: {
    teamId: "ABCDE12345",
    bundleIds: [BUNDLE, OUTLET_BUNDLE],
    outletBundleIds: [OUTLET_BUNDLE],
  },
  nearby: false,
};

let h: ProviderHarness;
beforeEach(async () => {
  h = await makeProviderHarness();
});

const google = (over: Record<string, unknown> = {}) =>
  h.signGoogle(googleClaims(NONCE, { aud: WEB, azp: AND, ...over }));
const apple = (over: Record<string, unknown> = {}) =>
  h.signApple(appleClaims(NONCE, { aud: BUNDLE, ...over }));
const verify = (token: string, nonce = NONCE, aud = AUD) =>
  verifyNativeToken(token, nonce, aud, h.env);

describe("native Google", () => {
  it("accepts a Credential Manager token: aud is the server client, azp the Android client (C1)", async () => {
    const id = await verify(await google());
    expect(id.kind).toBe("google");
    expect(id.tenantScopes).toEqual(["", `google-client:${WEB}`]);
    expect(id.issuerKey).toBe("https://accounts.google.com");
  });

  it("accepts a token with no azp and one whose azp is the server client", async () => {
    await verify(await google({ azp: undefined }));
    await verify(await google({ azp: WEB }));
  });

  it("refuses a foreign azp, a foreign aud, and a multi-audience token without azp", async () => {
    await expect(verify(await google({ azp: "evil" }))).rejects.toThrow(/azp/);
    await expect(verify(await google({ aud: "evil" }))).rejects.toBeInstanceOf(
      OidcVerifyError,
    );
    await expect(
      verify(await google({ aud: [WEB, "other"], azp: undefined })),
    ).rejects.toThrow(/azp/);
  });

  it("refuses the wrong issuer, a stale iat, an expired token and a nonce mismatch", async () => {
    await expect(
      verify(await google({ iss: "https://rogue.example" })),
    ).rejects.toBeInstanceOf(OidcVerifyError);
    await expect(
      verify(await google({ iat: nowSec() - 3600 })),
    ).rejects.toBeInstanceOf(OidcVerifyError);
    await expect(
      verify(await google({ iat: nowSec() - 7200, exp: nowSec() - 3600 })),
    ).rejects.toBeInstanceOf(OidcVerifyError);
    await expect(verify(await google(), "another")).rejects.toThrow(/nonce/);
    await expect(verify(await google({ nonce: undefined }))).rejects.toThrow(
      /nonce/,
    );
    await expect(verify(await google(), "")).rejects.toThrow();
  });

  it("holds iat to 5 minutes: 4 minutes old passes, 8 minutes old is refused", async () => {
    await verify(await google({ iat: nowSec() - 240 }));
    await verify(await apple({ iat: nowSec() - 240 }));
    await expect(
      verify(await google({ iat: nowSec() - 480 })),
    ).rejects.toThrow();
    await expect(
      verify(await apple({ iat: nowSec() - 480 })),
    ).rejects.toThrow();
  });

  it("refuses when the product has no server client id", async () => {
    await expect(
      verify(await google(), NONCE, {
        ...AUD,
        google: { serverClientId: null, clientIds: [AND] },
      }),
    ).rejects.toThrow();
  });

  it("refuses a product audience that is the card's platform client", async () => {
    const t = await h.signGoogle(googleClaims(NONCE));
    await expect(
      verify(t, NONCE, {
        ...AUD,
        google: { serverClientId: GOOGLE_CLIENT_ID, clientIds: [] },
      }),
    ).rejects.toThrow();
  });

  it("refuses a card token (aud = the platform client)", async () => {
    await expect(
      verify(await h.signGoogle(googleClaims(NONCE))),
    ).rejects.toBeInstanceOf(OidcVerifyError);
  });

  it("the card still refuses a native token, and still refuses azp other than its aud", async () => {
    const d = await discoverProvider("google");
    await expect(
      verifyProviderIdToken(d, await google(), {
        audience: GOOGLE_CLIENT_ID,
        nonce: NONCE,
      }),
    ).rejects.toBeInstanceOf(OidcVerifyError);
    await expect(
      verifyProviderIdToken(
        d,
        await h.signGoogle(googleClaims(NONCE, { azp: AND })),
        { audience: GOOGLE_CLIENT_ID, nonce: NONCE },
      ),
    ).rejects.toThrow(/azp/);
  });

  it("carries email_verified narrowed, never the raw claim", async () => {
    const id = await verify(
      await google({ email: "a@corp.example", email_verified: true }),
    );
    expect(id.emailVerified).toBe(false);
    const gm = await verify(
      await google({ email: "a@gmail.com", email_verified: true }),
    );
    expect(gm.emailVerified).toBe(true);
  });
});

describe("native Apple", () => {
  it("accepts a declared bundle id and an outlet's, scoped to the team", async () => {
    const a = await verify(await apple());
    expect(a.kind).toBe("apple");
    expect(a.tenantScopes).toEqual(["apple-team:ABCDE12345"]);
    await verify(await apple({ aud: OUTLET_BUNDLE }));
  });

  it("refuses another bundle id, any azp, the Services ID, and a nonce mismatch", async () => {
    await expect(verify(await apple({ aud: "com.evil" }))).rejects.toThrow();
    await expect(verify(await apple({ azp: BUNDLE }))).rejects.toThrow(/azp/);
    await expect(
      verify(await apple({ aud: APPLE_SERVICES_ID })),
    ).rejects.toThrow();
    await expect(verify(await apple(), "another")).rejects.toThrow(/nonce/);
    await expect(
      verify(await apple({ iat: nowSec() - 3600 })),
    ).rejects.toThrow();
  });

  it("refuses without a team, and refuses a product audience equal to the Services ID", async () => {
    await expect(
      verify(await apple(), NONCE, {
        ...AUD,
        apple: { ...AUD.apple, teamId: null },
      }),
    ).rejects.toThrow();
    await expect(
      verify(await apple({ aud: APPLE_SERVICES_ID }), NONCE, {
        ...AUD,
        apple: { ...AUD.apple, bundleIds: [APPLE_SERVICES_ID] },
      }),
    ).rejects.toThrow();
  });

  it("the card refuses a native Apple token", async () => {
    const d = await discoverProvider("apple");
    await expect(
      verifyProviderIdToken(d, await apple(), {
        audience: APPLE_SERVICES_ID,
        nonce: NONCE,
      }),
    ).rejects.toBeInstanceOf(OidcVerifyError);
  });
});

describe("provider pick", () => {
  it("is by the unverified iss; garbage and unknown issuers are refused", async () => {
    expect(nativeProviderOf(await google())).toBe("google");
    expect(nativeProviderOf(await apple())).toBe("apple");
    expect(nativeProviderOf("not-a-jwt")).toBeNull();
    expect(
      nativeProviderOf(await h.signGoogle({ iss: "https://rogue.example" })),
    ).toBeNull();
    await expect(verify("not-a-jwt")).rejects.toThrow();
  });
});
