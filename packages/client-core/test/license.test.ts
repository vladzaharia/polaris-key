// client-core's proof for the signed-in subject (WIRE-CONTRACT-V4 §2.1, §3.2, plans/SP-54.md):
// every `licenseUserCases` row of `conformance/corpus/v2/cases.json`, read from the verified
// payload, then the edges a signed corpus row cannot carry (a non-object document, inherited
// members, values a JSON parser never produces).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifyLicenseDoc } from "../src/verify.js";
import { licenseUserOf } from "../src/license.js";
import { licenseUserOf as fromBarrel } from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CASES = JSON.parse(
  readFileSync(join(ROOT, "conformance", "corpus", "v2", "cases.json"), "utf8"),
) as {
  licenseUserCases: {
    id: string;
    description: string;
    jws: string;
    trust: Record<string, string>;
    expectedAud: string;
    deviceId: string;
    now: number;
    expect: { accept: true; user: { subject: string } | null };
  }[];
};

const SUBJECT = "ps_4Xv9Lk2QmT7bNc0RfYp8Zw";
const doc = (profile: unknown): Record<string, unknown> => ({
  licenseId: "lic_1",
  profile,
});

describe("licenseUserOf (V4 §2.1, §3.2)", () => {
  it("is the barrel's export", () => {
    expect(fromBarrel).toBe(licenseUserOf);
  });

  it("replays every licenseUserCases row from the verified payload", async () => {
    expect(CASES.licenseUserCases).toHaveLength(14);
    for (const c of CASES.licenseUserCases) {
      const payload = await verifyLicenseDoc(c.jws, {
        trust: c.trust,
        expectedAud: c.expectedAud,
        deviceId: c.deviceId,
        now: c.now,
        lastAcceptedIssuedAt: null,
      });
      expect(payload, `${c.id} verifies`).not.toBeNull();
      expect(licenseUserOf(payload), c.id).toEqual(c.expect.user);
    }
  });

  it("returns a fresh object holding the subject only", () => {
    const user = { subject: SUBJECT, name: "Grace", email: "g@example.com" };
    const got = licenseUserOf(doc({ name: "Holder", user }));
    expect(got).toEqual({ subject: SUBJECT });
    expect(got).not.toBe(user);
  });

  it("is null for anything that is not a document object", () => {
    for (const v of [undefined, null, 0, "", "ps_x", [], [doc({})], true])
      expect(licenseUserOf(v)).toBeNull();
  });

  it("reads own members only, never through a prototype", () => {
    const inheritedProfile = Object.create({
      profile: { user: { subject: SUBJECT } },
    }) as object;
    expect(licenseUserOf(inheritedProfile)).toBeNull();
    const inheritedUser = doc(Object.create({ user: { subject: SUBJECT } }));
    expect(licenseUserOf(inheritedUser)).toBeNull();
    const inheritedSubject = doc({ user: Object.create({ subject: SUBJECT }) });
    expect(licenseUserOf(inheritedSubject)).toBeNull();
  });

  it("matches the whole subject with ASCII classes (§3.3 rule 1)", () => {
    const of = (subject: unknown) => licenseUserOf(doc({ user: { subject } }));
    expect(of(SUBJECT)).toEqual({ subject: SUBJECT });
    expect(of(`${SUBJECT}\n`)).toBeNull();
    expect(of(`${SUBJECT} `)).toBeNull();
    expect(of(` ${SUBJECT}`)).toBeNull();
    expect(of(SUBJECT.replace("4", "٤"))).toBeNull(); // ARABIC-INDIC DIGIT FOUR
    expect(of(SUBJECT.replace("X", "Ｘ"))).toBeNull(); // FULLWIDTH X
    expect(of(SUBJECT.toUpperCase())).toBeNull(); // PS_ prefix
    expect(of(new String(SUBJECT))).toBeNull();
  });
});
