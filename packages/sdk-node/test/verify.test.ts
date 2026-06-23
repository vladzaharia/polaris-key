import { describe, expect, it } from "vitest";
import { signJws, type TrustSet } from "@polaris-key/jws";
import type { ManagedConfigDoc } from "@polaris-key/protocol";
import { verifyDoc } from "../src/verify.js";

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
    profile: { name: "Ada Lovelace", firstName: "Ada", email: "ada@example.com", enrolledAt: 1 },
    payload: { config: {}, secrets: {}, entitlements: {} },
    ...over,
  };
}

const base = { trust, expectedAud: "djdl", deviceId: "dev-1" };

describe("verifyDoc", () => {
  it("accepts a well-formed, correctly-bound, signed doc and reproduces it", async () => {
    const doc = makeDoc();
    const jws = await signJws(doc, TEST_PEM, TEST_KID);
    const result = await verifyDoc(jws, base);
    expect(result).not.toBeNull();
    expect(result).toEqual(doc);
  });

  it("rejects a doc with the wrong audience (anti-cross-product splice)", async () => {
    const jws = await signJws(makeDoc({ aud: "other-product" }), TEST_PEM, TEST_KID);
    expect(await verifyDoc(jws, base)).toBeNull();
  });

  it("rejects a doc bound to a different deviceId (anti-cross-device splice)", async () => {
    const jws = await signJws(makeDoc({ deviceId: "someone-else" }), TEST_PEM, TEST_KID);
    expect(await verifyDoc(jws, base)).toBeNull();
  });

  it("rejects a non-monotonic issuedAt (equal to the floor is not strictly newer)", async () => {
    const jws = await signJws(makeDoc({ issuedAt: 1000 }), TEST_PEM, TEST_KID);
    expect(await verifyDoc(jws, { ...base, lastAcceptedIssuedAt: 1000 })).toBeNull();
  });

  it("rejects an issuedAt strictly older than the floor (replay)", async () => {
    const jws = await signJws(makeDoc({ issuedAt: 999 }), TEST_PEM, TEST_KID);
    expect(await verifyDoc(jws, { ...base, lastAcceptedIssuedAt: 1000 })).toBeNull();
  });

  it("accepts an issuedAt strictly newer than the floor", async () => {
    const doc = makeDoc({ issuedAt: 1001 });
    const jws = await signJws(doc, TEST_PEM, TEST_KID);
    const result = await verifyDoc(jws, { ...base, lastAcceptedIssuedAt: 1000 });
    expect(result?.issuedAt).toBe(1001);
  });

  it("rejects a tampered payload (signature no longer matches)", async () => {
    const jws = await signJws(makeDoc(), TEST_PEM, TEST_KID);
    const [h, p, s] = jws.split(".") as [string, string, string];
    const decoded = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as ManagedConfigDoc;
    decoded.licenseId = "TAMPERED";
    const tampered = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
    expect(await verifyDoc(`${h}.${tampered}.${s}`, base)).toBeNull();
  });

  it("rejects an unknown kid (not in the trust set)", async () => {
    const jws = await signJws(makeDoc(), TEST_PEM, TEST_KID);
    expect(await verifyDoc(jws, { ...base, trust: { "some-other-kid": TEST_PUB } })).toBeNull();
  });

  it("rejects a non-EdDSA alg header (no none/HS downgrade)", async () => {
    const jws = await signJws(makeDoc(), TEST_PEM, TEST_KID);
    const [, p, s] = jws.split(".") as [string, string, string];
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", kid: TEST_KID }), "utf8").toString("base64url");
    expect(await verifyDoc(`${noneHeader}.${p}.${s}`, base)).toBeNull();
  });

  it("rejects structurally malformed input", async () => {
    expect(await verifyDoc("not-a-jws", base)).toBeNull();
    expect(await verifyDoc("a.b", base)).toBeNull();
    expect(await verifyDoc("@@@.@@@.@@@", base)).toBeNull();
  });
});
