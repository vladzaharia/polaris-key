import { describe, expect, it } from "vitest";
import { verifyJws } from "@polaris-key/jws";
import {
  DOC_EXPIRY_SECONDS,
  ISSUER,
  SECONDS_PER_DAY,
  type DocProfile,
  type ManagedConfigDoc,
  type ManagedPayload,
} from "@polaris-key/protocol";
import { buildDoc, computeETag, signDoc } from "../src/configDoc.js";
import { TEST_KID, TEST_PEM, TEST_PUB, NOW } from "./seed.js";

const profile: DocProfile = {
  name: "Ada Lovelace",
  firstName: "Ada",
  email: "ada@x.io",
  enrolledAt: NOW,
};
const payload: ManagedPayload = {
  config: {
    "run.concurrency": { state: "enforced", value: 4, updatedAt: NOW },
  },
  secrets: {},
  entitlements: {
    polarisVpn: { state: "enforced", value: true, updatedAt: NOW },
  },
};

const input = (over: Partial<Parameters<typeof buildDoc>[0]> = {}) => ({
  schemaVersion: 1,
  aud: "djdl",
  licenseId: "lic_1",
  deviceId: "dev-1",
  now: NOW,
  maxOfflineDays: 30,
  profile,
  payload,
  ...over,
});

describe("buildDoc", () => {
  it("stamps the time-bound fields and copies through identity", () => {
    const doc = buildDoc(input());
    expect(doc.schemaVersion).toBe(1);
    expect(doc.aud).toBe("djdl");
    expect(doc.iss).toBe(ISSUER);
    expect(doc.licenseId).toBe("lic_1");
    expect(doc.deviceId).toBe("dev-1");
    expect(doc.issuedAt).toBe(NOW);
    expect(doc.expiresAt).toBe(NOW + DOC_EXPIRY_SECONDS);
    expect(doc.graceUntil).toBe(NOW + 30 * SECONDS_PER_DAY);
    expect(doc.profile).toEqual(profile);
    expect(doc.payload).toEqual(payload);
  });

  it("derives graceUntil from the maxOfflineDays window", () => {
    expect(buildDoc(input({ maxOfflineDays: 7 })).graceUntil).toBe(
      NOW + 7 * SECONDS_PER_DAY,
    );
    expect(buildDoc(input({ maxOfflineDays: 0 })).graceUntil).toBe(NOW);
  });

  it("emits fields in the conformance-corpus order", () => {
    const keys = Object.keys(buildDoc(input()));
    expect(keys).toEqual([
      "schemaVersion",
      "aud",
      "iss",
      "licenseId",
      "deviceId",
      "issuedAt",
      "expiresAt",
      "graceUntil",
      "profile",
      "payload",
    ]);
  });
});

describe("computeETag", () => {
  it("is a quoted strong tag", async () => {
    const tag = await computeETag(buildDoc(input()));
    expect(tag).toMatch(/^"[A-Za-z0-9_-]+"$/);
  });

  it("is stable across differing timestamps (content-only)", async () => {
    const a = await computeETag(buildDoc(input({ now: NOW })));
    const b = await computeETag(
      buildDoc(input({ now: NOW + 100_000, maxOfflineDays: 99 })),
    );
    expect(a).toBe(b);
  });

  it("changes when the payload changes", async () => {
    const a = await computeETag(buildDoc(input()));
    const altered: ManagedPayload = {
      ...payload,
      config: {
        "run.concurrency": { state: "enforced", value: 8, updatedAt: NOW },
      },
    };
    const b = await computeETag(buildDoc(input({ payload: altered })));
    expect(a).not.toBe(b);
  });

  it("changes when identity (aud/licenseId/deviceId/profile) changes", async () => {
    const base = await computeETag(buildDoc(input()));
    expect(await computeETag(buildDoc(input({ aud: "acme" })))).not.toBe(base);
    expect(await computeETag(buildDoc(input({ licenseId: "lic_2" })))).not.toBe(
      base,
    );
    expect(await computeETag(buildDoc(input({ deviceId: "dev-2" })))).not.toBe(
      base,
    );
    const profile2: DocProfile = { ...profile, name: "Grace Hopper" };
    expect(await computeETag(buildDoc(input({ profile: profile2 })))).not.toBe(
      base,
    );
  });
});

describe("signDoc", () => {
  it("produces a JWS that verifies under the test trust set with aud=product", async () => {
    const doc = buildDoc(input());
    const jws = await signDoc(doc, TEST_PEM, TEST_KID);
    const v = await verifyJws<ManagedConfigDoc>(jws, { [TEST_KID]: TEST_PUB });
    expect(v).not.toBeNull();
    expect(v!.kid).toBe(TEST_KID);
    expect(v!.payload.aud).toBe("djdl");
    expect(v!.payload.iss).toBe(ISSUER);
    expect(v!.payload.payload.entitlements.polarisVpn?.value).toBe(true);
  });

  it("fails verification under an unrelated trust set", async () => {
    const jws = await signDoc(buildDoc(input()), TEST_PEM, TEST_KID);
    const v = await verifyJws<ManagedConfigDoc>(jws, { "other-kid": TEST_PUB });
    expect(v).toBeNull();
  });
});
