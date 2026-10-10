/**
 * SP-54 (WIRE-CONTRACT-V4 §2.1, plans/SP-54.md §4, §6): the licence document carries
 * `profile.user = {subject}` for a device an account is signed in on, and for no other.
 *
 *   - `docProfile(license, device)` is `docProfile(license)` plus `user` exactly when the device's
 *     stored subject is a well-formed pairwise subject, over a grid of licences and stored values;
 *     every other input yields today's bytes.
 *   - Through `GET /<p>/license/document`: a signed-in device reads its subject back through
 *     client-core's `licenseUserOf`; a key-entry device on the same licence, a malformed stored
 *     subject and a signed-out device get no `user` (and never a failed request); nothing about
 *     the account but the subject reaches the payload.
 *   - Every licence document recorded in `conformance/transcripts/` has today's four profile
 *     members, plus `user` only in the transcripts whose device is signed in.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { licenseUserOf } from "@polaris-key/client-core";
import { PAIRWISE_SUBJECT_PATTERN } from "@polaris-key/protocol/core";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "./seed.js";
import { docProfile } from "../src/core/licensing/authz.js";
import type { LicenseRow } from "../src/core/repo.js";
import { loadProduct } from "../src/core/products.js";
import { setServices } from "../src/core/repo.js";
import { DEFAULT_SERVICES, serializeServices } from "../src/core/services.js";
import { setDeviceSubject } from "../src/core/accounts/accountSubjects.js";
import { clearDeviceSubjects } from "../src/core/accounts/subjectHooks.js";
import { handleActivate } from "../src/services/license/activation.js";
import { handleLicenseDocument } from "../src/services/license/document.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";

const SUBJECT = "ps_4Xv9Lk2QmT7bNc0RfYp8Zw";
const PROFILE_KEYS = ["name", "firstName", "email", "activatedAt"];

function payloadOf(jws: string): Record<string, unknown> {
  const part = jws.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

function headerOf(jws: string): Record<string, unknown> | null {
  try {
    return JSON.parse(
      Buffer.from(jws.split(".")[0] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const licenseRow = (over: Partial<LicenseRow> = {}): LicenseRow =>
  ({
    product: "djdl",
    id: "lic_1",
    status: "active",
    sub: null,
    name: "Ada Lovelace",
    email: "ada@example.com",
    groups_json: null,
    tier_id: null,
    activated_at: NOW,
    ...over,
  }) as LicenseRow;

describe("docProfile(license, device) (plans/SP-54.md §6)", () => {
  const licences = [
    licenseRow(),
    licenseRow({ name: null, email: null }),
    licenseRow({ name: "", email: "" }),
    licenseRow({ name: "Grâce Hôpper-Ñ", email: "g@example.org" }),
    licenseRow({ name: "Single", activated_at: 0 }),
  ];
  // Every stored value that is not a well-formed pairwise subject, and the absent ones.
  const noUser: unknown[] = [
    undefined,
    null,
    "",
    "ps_short",
    `${SUBJECT}\n`,
    `${SUBJECT}A`,
    SUBJECT.slice(0, -1),
    `us_${SUBJECT.slice(3)}`,
    SUBJECT.replace("4", "٤"),
    ` ${SUBJECT}`,
    "acct_0123456789abcdef0123456789abcdef",
    "ada@example.com",
  ];
  const valid = [
    SUBJECT,
    `ps_${"A".repeat(22)}`,
    `ps_${"-".repeat(11)}${"_".repeat(11)}`,
  ];

  it("with no device, or a device without a well-formed subject, is today's block byte for byte", () => {
    for (const l of licences) {
      const today = JSON.stringify(docProfile(l));
      expect(Object.keys(docProfile(l))).toEqual(PROFILE_KEYS);
      expect(JSON.stringify(docProfile(l, undefined))).toBe(today);
      expect(JSON.stringify(docProfile(l, null))).toBe(today);
      for (const subject of noUser)
        expect(
          JSON.stringify(docProfile(l, { subject: subject as string | null })),
          `${JSON.stringify(subject)}`,
        ).toBe(today);
    }
  });

  it("with a signed-in device, is today's block plus user: {subject}, appended last", () => {
    for (const l of licences)
      for (const subject of valid) {
        const today = docProfile(l);
        const got = docProfile(l, { subject });
        expect(new RegExp(PAIRWISE_SUBJECT_PATTERN).test(subject)).toBe(true);
        expect(got).toEqual({ ...today, user: { subject } });
        expect(Object.keys(got)).toEqual([...PROFILE_KEYS, "user"]);
        expect(Object.keys(got.user!)).toEqual(["subject"]);
        // Byte level: the signed JSON is today's with one member appended.
        expect(JSON.stringify(got)).toBe(
          `${JSON.stringify(today).slice(0, -1)},"user":{"subject":"${subject}"}}`,
        );
      }
  });

  it("reads only the device's subject: nothing else about the device or an account is added", () => {
    const device = {
      subject: SUBJECT,
      customer_id: "acct_secret",
      label: "Ada's laptop",
      ua: "agent",
      bound_by: "signin",
    };
    const got = docProfile(licenseRow(), device);
    expect(got.user).toEqual({ subject: SUBJECT });
    const text = JSON.stringify(got);
    for (const leak of ["acct_secret", "Ada's laptop", "agent", "signin"])
      expect(text).not.toContain(leak);
  });
});

describe("GET /<p>/license/document carries the signed-in subject (V4 §2.1)", () => {
  it("a signed-in device gets user; a key device, a malformed binding and a signed-out device do not", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    // A device binding needs Identity on (PX-W17's bind guard).
    await setServices(
      db,
      "djdl",
      serializeServices({
        services: { ...DEFAULT_SERVICES, identity: { enabled: true } },
      }),
      "manifest",
      NOW,
    );
    const product = (await loadProduct(env, db, "djdl"))!;
    const { key } = await seedLicenseWithKey(db, "djdl");

    // The account signs in with an address that is not the licence's, so a leak is visible.
    // Its licence stays floating: the binding, not ownership, is what the member reports.
    const signedIn = await signIn(
      db,
      { issuerKey: "email", subject: "grace@account.example", kind: "email" },
      NOW,
      { product: { slug: "djdl" } },
    );
    if (signedIn.status !== "signed_in") throw new Error("sign-in failed");
    const accountId = signedIn.account.id;
    const subject = signedIn.subject!;
    expect(subject).toMatch(new RegExp(PAIRWISE_SUBJECT_PATTERN));

    const activate = async (deviceId: string): Promise<string> => {
      const res = await handleActivate(
        mkReq("POST", {
          authorization: `Bearer ${key}`,
          "x-pkey-device": deviceId,
        }),
        env,
        db,
        product,
        NOW,
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { token: string }).token;
    };
    const fetchDoc = async (token: string, deviceId: string) => {
      const res = await handleLicenseDocument(
        mkReq("GET", {
          authorization: `Bearer ${token}`,
          "x-pkey-device": deviceId,
        }),
        env,
        db,
        product,
        NOW,
      );
      // A stored value never turns into a failed request.
      expect(res.status).toBe(200);
      const jws = await res.text();
      return { jws, payload: payloadOf(jws) };
    };

    const signedInToken = await activate("dev-signed-in");
    const keyToken = await activate("dev-key");
    expect(
      await setDeviceSubject(env, db, "djdl", "dev-signed-in", subject),
    ).toBe(true);

    // The signed-in device: profile.user is the subject, read back by the client reader.
    const mine = await fetchDoc(signedInToken, "dev-signed-in");
    const profile = mine.payload.profile as Record<string, unknown>;
    expect(Object.keys(profile)).toEqual([...PROFILE_KEYS, "user"]);
    expect(profile.user).toEqual({ subject });
    expect(licenseUserOf(mine.payload)).toEqual({ subject });
    // Only the subject: never the account id, the account's address or its link.
    const text = JSON.stringify(mine.payload);
    expect(text).not.toContain(accountId);
    expect(text).not.toContain("grace@account.example");
    // The holder's own name and email are still the licence's.
    expect(profile.email).toBe("ada@example.com");

    // The same licence on a device activated by key: no user, today's profile.
    const keyDoc = await fetchDoc(keyToken, "dev-key");
    expect(
      Object.keys(keyDoc.payload.profile as Record<string, unknown>),
    ).toEqual(PROFILE_KEYS);
    expect(licenseUserOf(keyDoc.payload)).toBeNull();
    expect(JSON.stringify(keyDoc.payload)).not.toContain(subject);

    // A malformed stored value emits nothing and still answers 200.
    for (const bad of ["ps_short", `${subject}\n`, `acct_${accountId}`]) {
      await db.run(
        "UPDATE devices SET subject = ? WHERE product = 'djdl' AND device_id = 'dev-signed-in'",
        bad,
      );
      const doc = await fetchDoc(signedInToken, "dev-signed-in");
      expect(
        Object.keys(doc.payload.profile as Record<string, unknown>),
        JSON.stringify(bad),
      ).toEqual(PROFILE_KEYS);
      expect(licenseUserOf(doc.payload)).toBeNull();
    }

    // Sign-out drops the binding, and the next document drops the member.
    expect(
      await setDeviceSubject(env, db, "djdl", "dev-signed-in", subject),
    ).toBe(true);
    expect(
      licenseUserOf((await fetchDoc(signedInToken, "dev-signed-in")).payload),
    ).toEqual({ subject });
    await clearDeviceSubjects(
      db,
      env,
      { kind: "device", product: "djdl", deviceId: "dev-signed-in" },
      "signout",
    );
    const after = await fetchDoc(signedInToken, "dev-signed-in");
    expect(licenseUserOf(after.payload)).toBeNull();
    expect(
      Object.keys(after.payload.profile as Record<string, unknown>),
    ).toEqual(PROFILE_KEYS);
  });
});

describe("every recorded licence document (conformance/transcripts)", () => {
  const dir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "conformance",
    "transcripts",
  );
  // The transcripts whose device holds an account sign-in (`devices.subject`) when it fetches its
  // document. None today: `devicecode-happy` signs in through the product's own OIDC, which binds
  // no pairwise subject (`authorizeAndMint`, plans/I-04.md §8 Q6), and `identity-attach` fetches
  // its document at activation, before the binding is seeded. I-08's passthrough sign-in binds
  // one, and its re-recorded transcripts belong here.
  const SIGNED_IN = new Set<string>();
  const JWS = /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
  const subjectRe = new RegExp(PAIRWISE_SUBJECT_PATTERN);

  it("has today's profile, plus user = {subject} exactly where a device is signed in", () => {
    const withUser = new Set<string>();
    let documents = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const id = file.slice(0, -".json".length);
      const text = readFileSync(join(dir, file), "utf8");
      for (const jws of text.match(JWS) ?? []) {
        if (headerOf(jws)?.typ !== "pkey-license+jws") continue;
        documents += 1;
        const payload = payloadOf(jws);
        const profile = payload.profile as Record<string, unknown>;
        const keys = Object.keys(profile);
        if (keys.includes("user")) {
          withUser.add(id);
          expect(keys, id).toEqual([...PROFILE_KEYS, "user"]);
          const user = profile.user as Record<string, unknown>;
          expect(Object.keys(user), id).toEqual(["subject"]);
          expect(subjectRe.test(user.subject as string), id).toBe(true);
          expect(licenseUserOf(payload), id).toEqual(user);
        } else {
          expect(keys, id).toEqual(PROFILE_KEYS);
          expect(licenseUserOf(payload), id).toBeNull();
        }
      }
    }
    expect(documents).toBeGreaterThan(0);
    expect([...withUser].sort()).toEqual([...SIGNED_IN].sort());
  });
});
