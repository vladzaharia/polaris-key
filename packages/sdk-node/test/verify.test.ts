import { describe, expect, it } from "vitest";
import { signJws, type TrustSet } from "@polaris-key/jws";
import type { ManagedConfigDoc } from "@polaris-key/protocol";
import { verifyDoc } from "../src/verify.js";
import { CLOCK_SKEW_SECONDS, MAX_GRACE_SECONDS } from "../src/claims.js";

const TEST_KID = "pkey-test-prod-2026";
const TEST_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

const trust: TrustSet = { [TEST_KID]: TEST_PUB };

function makeDoc(over: Partial<ManagedConfigDoc> = {}): ManagedConfigDoc {
  return {
    schemaVersion: 1,
    aud: "djdl",
    iss: "key.plrs.im",
    licenseId: "lic-1",
    deviceId: "dev-1",
    issuedAt: 1000,
    expiresAt: 4600,
    graceUntil: 2_592_000,
    profile: {
      name: "Ada Lovelace",
      firstName: "Ada",
      email: "ada@example.com",
      activatedAt: 1,
    },
    payload: { config: {}, secrets: {}, entitlements: {} },
    ...over,
  };
}

// The fixture doc lives on its own little timeline (issuedAt 1000, expiresAt 4600), so the
// clock is pinned rather than read from the wall — verifyDoc now asserts the freshness window
// and would otherwise reject every 1970-epoch fixture.
const NOW = 2000;
const base = { trust, expectedAud: "djdl", deviceId: "dev-1", now: NOW };

describe("verifyDoc", () => {
  it("accepts a well-formed, correctly-bound, signed doc and reproduces it", async () => {
    const doc = makeDoc();
    const jws = await signJws(doc, TEST_PEM, TEST_KID);
    const result = await verifyDoc(jws, base);
    expect(result).not.toBeNull();
    expect(result).toEqual(doc);
  });

  it("rejects a doc with the wrong audience (anti-cross-product splice)", async () => {
    const jws = await signJws(
      makeDoc({ aud: "other-product" }),
      TEST_PEM,
      TEST_KID,
    );
    expect(await verifyDoc(jws, base)).toBeNull();
  });

  it("rejects a doc bound to a different deviceId (anti-cross-device splice)", async () => {
    const jws = await signJws(
      makeDoc({ deviceId: "someone-else" }),
      TEST_PEM,
      TEST_KID,
    );
    expect(await verifyDoc(jws, base)).toBeNull();
  });

  it("rejects a non-monotonic issuedAt (equal to the floor is not strictly newer)", async () => {
    const jws = await signJws(makeDoc({ issuedAt: 1000 }), TEST_PEM, TEST_KID);
    expect(
      await verifyDoc(jws, { ...base, lastAcceptedIssuedAt: 1000 }),
    ).toBeNull();
  });

  it("rejects an issuedAt strictly older than the floor (replay)", async () => {
    const jws = await signJws(makeDoc({ issuedAt: 999 }), TEST_PEM, TEST_KID);
    expect(
      await verifyDoc(jws, { ...base, lastAcceptedIssuedAt: 1000 }),
    ).toBeNull();
  });

  it("accepts an issuedAt strictly newer than the floor", async () => {
    const doc = makeDoc({ issuedAt: 1001 });
    const jws = await signJws(doc, TEST_PEM, TEST_KID);
    const result = await verifyDoc(jws, {
      ...base,
      lastAcceptedIssuedAt: 1000,
    });
    expect(result?.issuedAt).toBe(1001);
  });

  it("rejects a tampered payload (signature no longer matches)", async () => {
    const jws = await signJws(makeDoc(), TEST_PEM, TEST_KID);
    const [h, p, s] = jws.split(".") as [string, string, string];
    const decoded = JSON.parse(
      Buffer.from(p, "base64url").toString("utf8"),
    ) as ManagedConfigDoc;
    decoded.licenseId = "TAMPERED";
    const tampered = Buffer.from(JSON.stringify(decoded), "utf8").toString(
      "base64url",
    );
    expect(await verifyDoc(`${h}.${tampered}.${s}`, base)).toBeNull();
  });

  it("rejects an unknown kid (not in the trust set)", async () => {
    const jws = await signJws(makeDoc(), TEST_PEM, TEST_KID);
    expect(
      await verifyDoc(jws, { ...base, trust: { "some-other-kid": TEST_PUB } }),
    ).toBeNull();
  });

  it("rejects a non-EdDSA alg header (no none/HS downgrade)", async () => {
    const jws = await signJws(makeDoc(), TEST_PEM, TEST_KID);
    const [, p, s] = jws.split(".") as [string, string, string];
    const noneHeader = Buffer.from(
      JSON.stringify({ alg: "none", kid: TEST_KID }),
      "utf8",
    ).toString("base64url");
    expect(await verifyDoc(`${noneHeader}.${p}.${s}`, base)).toBeNull();
  });

  it("rejects structurally malformed input", async () => {
    expect(await verifyDoc("not-a-jws", base)).toBeNull();
    expect(await verifyDoc("a.b", base)).toBeNull();
    expect(await verifyDoc("@@@.@@@.@@@", base)).toBeNull();
  });
});

// Wire contract v2 §3. Every one of these was silently accepted by v1 (finding R2-08).
describe("verifyDoc — claim validation (wire contract v2 §3)", () => {
  const sign = (over: Partial<ManagedConfigDoc> = {}): Promise<string> =>
    signJws(makeDoc(over), TEST_PEM, TEST_KID, "pkey-config+jws");

  it("rejects a foreign `iss`", async () => {
    expect(await verifyDoc(await sign({ iss: "https://evil.example" }), base)) //
      .toBeNull();
    // …and honours an explicitly configured issuer.
    expect(
      await verifyDoc(await sign({ iss: "other.test" }), {
        ...base,
        expectedIss: "other.test",
      }),
    ).not.toBeNull();
  });

  it("rejects an expired doc outright, with CLOCK_SKEW of leeway", async () => {
    const jws = await sign();
    // expiresAt 4600 — still accepted one skew-window past it…
    expect(
      await verifyDoc(jws, { ...base, now: 4600 + CLOCK_SKEW_SECONDS - 1 }),
    ).not.toBeNull();
    // …and refused one second later.
    expect(
      await verifyDoc(jws, { ...base, now: 4600 + CLOCK_SKEW_SECONDS + 1 }),
    ).toBeNull();
  });

  it("rejects a far-future issuedAt (there was no nbf/iat sanity check at all)", async () => {
    const future = 10 * 365 * 86400;
    expect(
      await verifyDoc(
        await sign({
          issuedAt: future,
          expiresAt: future + 3600,
          graceUntil: future + 3600,
        }),
        base,
      ),
    ).toBeNull();
  });

  it("tolerates a clock CLOCK_SKEW seconds fast on a freshly-signed doc", async () => {
    // v1 had zero leeway: a client an hour fast flipped a brand-new doc into `grace`.
    const t = 1_700_000_000;
    const jws = await sign({
      issuedAt: t,
      expiresAt: t + 3600,
      graceUntil: t + 30 * 86400,
    });
    expect(
      await verifyDoc(jws, { ...base, now: t - CLOCK_SKEW_SECONDS }),
    ).not.toBeNull();
  });

  it("bounds graceUntil: never below expiresAt, never beyond a year from issuedAt", async () => {
    expect(
      await verifyDoc(await sign({ graceUntil: 4599 }), base), // < expiresAt
    ).toBeNull();
    expect(
      await verifyDoc(
        await sign({ graceUntil: 1000 + MAX_GRACE_SECONDS + 1 }),
        base,
      ),
    ).toBeNull();
    expect(
      await verifyDoc(
        await sign({ graceUntil: 1000 + MAX_GRACE_SECONDS }),
        base,
      ),
    ).not.toBeNull();
  });

  it("rejects a malformed schemaVersion but accepts any product catalog version", async () => {
    // The field carries the PRODUCT CATALOG version (worker product.ts:114), so 999 is a
    // perfectly ordinary value — the shape is what is enforceable.
    expect(await verifyDoc(await sign({ schemaVersion: 999 }), base))
      .not //
      .toBeNull();
    expect(
      await verifyDoc(
        await sign({ schemaVersion: "1" as unknown as number }),
        base,
      ),
    ).toBeNull();
    expect(await verifyDoc(await sign({ schemaVersion: 0 }), base)).toBeNull();
  });

  it("rejects a trust manifest replayed into a config-doc call site (typ domain separation)", async () => {
    const manifest = await signJws(
      {
        schemaVersion: 1,
        aud: "djdl",
        iss: "key.plrs.im",
        issuedAt: 1000,
        expiresAt: 4600,
        jwksUrl: "https://k.test/djdl/.well-known/jwks.json",
        cacheSeconds: 300,
        keys: [],
      },
      TEST_PEM,
      TEST_KID,
      "pkey-trust+jws",
    );
    expect(await verifyDoc(manifest, base)).toBeNull();
  });

  it("cache-reload path (checkFreshness:false) keeps offline grace alive", async () => {
    // A cached doc is EXPECTED to be past its short expiresAt — that is what offline
    // operation is. Its signed outer bound is graceUntil, enforced by the gate.
    const jws = await sign();
    const wayPastExpiry = 4600 + 10 * 86400;
    expect(await verifyDoc(jws, { ...base, now: wayPastExpiry })).toBeNull();
    expect(
      await verifyDoc(jws, {
        ...base,
        now: wayPastExpiry,
        checkFreshness: false,
      }),
    ).not.toBeNull();
  });
});
