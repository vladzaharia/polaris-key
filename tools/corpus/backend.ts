// `backend-matrix.json` v1 (SP-53, plans/SP-53.md §4; WIRE-CONTRACT-V4 §14): product backends.
//
// Three sections, every row recomputed by the independent reference in `reference/backend.ts`
// (which imports nothing it checks) and compared with the expectation written here, so a row that
// contradicts the contract fails `pnpm gen corpus` instead of shipping:
//
//   verdict   {headers, now, options, trust} → {status, code, context}      §14.2 (server cores)
//   problem   {code, acceptLanguage, realm}  → {status, locale, challenge,  §14.3 (server cores)
//                                               type, title, detail}
//   client    {document, now, response, retried} → {action}                 §14.5 (client halves)
//
// The licence documents are signed here with the corpus test keys. The rows that carry a
// signed-in account build `profile.user` inline, so this file does not wait for SP-54's Worker
// change. The problem titles and details are the copy catalog's (`conformance/parity/copy.<locale>
// .json`): a copy edit regenerates this file, and `--check` fails until it is committed.
//
// client-core (`@polaris-key/client-core/backend`) is the first implementation. It is checked
// against this file, row by row, by the Node and browser runners, like every SDK; the generator
// never imports it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signJws } from "@polaris-key/jws";
import {
  ALT_KID,
  AUD_V3,
  DEVICE_V3,
  licenseDoc,
  configDoc,
  PIN_KID,
  pub,
  REPO_ROOT,
  signAs,
  utf8Bytes,
  V3_EXPIRES,
  V3_GRACE,
  V3_ISSUED,
  V3_NOW,
  type TypV3,
} from "./common.js";
import {
  REF_AUTH_SCHEME,
  REF_BACKEND_STATUS,
  REF_HEADER_DEVICE,
  REF_HEADER_LICENSE,
  REF_LICENSE_MAX_BYTES,
  REF_LOCALES,
  REF_REFRESH_MARGIN,
  REF_SUBJECT_RE,
  REF_TYPE_BASE,
  refBackendProblem,
  refBackendVerdict,
  refClientBackendAction,
  type RefBackendCode,
  type RefClientAction,
  type RefClientInput,
  type RefContext,
  type RefLocale,
  type RefProblem,
  type RefRequirement,
  type RefVerdict,
  type RefVerdictInput,
} from "./reference/backend.js";

const LIC: TypV3 = "pkey-license+jws";
const SKEW = 300;
/** A pairwise subject (§8): `ps_` and 22 base64url characters. */
const SUBJECT = "ps_4Xv9Lk2QmT7bNc0RfYp8Zw";
/** A second product a multi-product backend serves, whose key is `ALT_KID`. */
const ACME = "acme";

/** A fixed Ed25519 seed that is no corpus key: the attacker's key, signing under the pinned kid. */
const FOREIGN_SEED =
  "5f1f2c3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6";
const foreignPem = (): string =>
  `-----BEGIN PRIVATE KEY-----\n${Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(FOREIGN_SEED, "hex"),
  ]).toString("base64")}\n-----END PRIVATE KEY-----`;

const b64len = (bytes: number): number => Math.floor((bytes * 4 + 2) / 3);

/** A licence document padded so that its compact JWS signed by `kid` is exactly `target` bytes.
 *  `pad` is a member outside the claims (§3.2), which every verifier ignores. Returns null when
 *  no padding reaches the target with this kid (a base64url length is never 1 mod 4). */
function paddedToJws(
  target: number,
  kid: string,
): Record<string, unknown> | null {
  const header = JSON.stringify({ alg: "EdDSA", typ: LIC, kid });
  const fixed = b64len(utf8Bytes(header).length) + 2 + 86;
  for (let pad = 0; pad < target; pad++) {
    const doc = licenseDoc({ pad: "A".repeat(pad) });
    const total = fixed + b64len(utf8Bytes(JSON.stringify(doc)).length);
    if (total === target) return doc;
    if (total > target) return null;
  }
  return null;
}

async function exactJws(target: number): Promise<string> {
  for (const kid of [PIN_KID, ALT_KID]) {
    const doc = paddedToJws(target, kid);
    if (!doc) continue;
    const jws = await signAs(doc, kid, LIC);
    if (jws.length !== target)
      throw new Error(
        `backend-matrix: padded JWS is ${jws.length}, not ${target}`,
      );
    return jws;
  }
  throw new Error(`backend-matrix: no padding reaches a ${target}-byte JWS`);
}

/** The options a row passes; `require` and `maxAgeSeconds` appear only when set. */
const opts = (
  o: {
    products?: string[];
    maxAgeSeconds?: number;
    require?: RefRequirement[];
  } = {},
): RefVerdictInput["options"] => ({
  products: o.products ?? [AUD_V3],
  ...(o.maxAgeSeconds !== undefined ? { maxAgeSeconds: o.maxAgeSeconds } : {}),
  ...(o.require ? { require: o.require } : {}),
});

const TRUST_ONE = { [AUD_V3]: { [PIN_KID]: pub(PIN_KID) } };
const TRUST_TWO = {
  [ACME]: { [ALT_KID]: pub(ALT_KID) },
  [AUD_V3]: { [PIN_KID]: pub(PIN_KID) },
};

/** The context a passing document attaches, from the fixture's own values (§14.2). */
function ctx(
  o: {
    product?: string;
    issuedAt?: number;
    now?: number;
    tier?: string | null;
    holder?: { name: string; email: string } | null;
    user?: { subject: string } | null;
    deviceId?: string;
    id?: string;
  } = {},
): RefContext {
  const issuedAt = o.issuedAt ?? V3_ISSUED;
  const now = o.now ?? V3_NOW;
  return {
    license: {
      product: o.product ?? AUD_V3,
      id: o.id ?? "lic_3f8a9b",
      deviceId: o.deviceId ?? DEVICE_V3,
      tier: o.tier === undefined ? "pro" : o.tier,
      issuedAt,
      ageSeconds: Math.max(0, now - issuedAt),
      holder:
        o.holder === undefined
          ? { name: "Grace Hopper", email: "grace@example.com" }
          : o.holder,
    },
    user: o.user ?? null,
  };
}

const pass = (context: RefContext): RefVerdict => ({
  status: 200,
  code: null,
  context,
});
const refused = (
  code: RefBackendCode,
  context: RefContext | null = null,
): RefVerdict => ({ status: REF_BACKEND_STATUS[code], code, context });

const BASE_PROFILE = {
  name: "Grace Hopper",
  firstName: "Grace",
  email: "grace@example.com",
  activatedAt: 1690000000,
};

interface VerdictRow {
  id: string;
  description: string;
  input: RefVerdictInput;
  expect: RefVerdict;
}

async function verdictRows(): Promise<VerdictRow[]> {
  const sign = (doc: Record<string, unknown>, kid = PIN_KID, typ = LIC) =>
    signAs(doc, kid, typ);
  const J = await sign(licenseDoc());
  const [h, p, s] = J.split(".") as [string, string, string];
  const withSubject = await sign(
    licenseDoc({ profile: { ...BASE_PROFILE, user: { subject: SUBJECT } } }),
  );
  const at16384 = await exactJws(REF_LICENSE_MAX_BYTES);
  const at16385 = await exactJws(REF_LICENSE_MAX_BYTES + 1);
  const at16384Kid = (
    JSON.parse(
      Buffer.from(at16384.split(".")[0]!, "base64url").toString("utf8"),
    ) as { kid: string }
  ).kid;
  // The bad signature: one character of S flipped, staying in the alphabet and canonical.
  const flip = (c: string) => (c === "A" ? "B" : "A");
  const badSig = `${h}.${p}.${s.slice(0, 10)}${flip(s[10]!)}${s.slice(11)}`;
  const tampered = `${h}.${(await sign(licenseDoc({ licenseId: "lic_other" }))).split(".")[1]}.${s}`;
  const foreign = await signJws(licenseDoc(), foreignPem(), PIN_KID, LIC);
  const altKid = await sign(licenseDoc(), ALT_KID);
  const asConfigTyp = await sign(licenseDoc(), PIN_KID, "pkey-config+jws");
  const configDocument = await sign(configDoc(), PIN_KID, "pkey-config+jws");
  const wrongIss = await sign(licenseDoc({ iss: "plrs.im" }));
  const acmeByPin = await sign(licenseDoc({ aud: ACME }));
  const acmeByAlt = await sign(licenseDoc({ aud: ACME }), ALT_KID);
  const numericDevice = await sign(licenseDoc({ deviceId: 42 }));
  const emptyDevice = await sign(licenseDoc({ deviceId: "" }));
  const noLicenseId = await sign(
    (() => {
      const d = licenseDoc();
      delete d.licenseId;
      return d;
    })(),
  );
  const graceOverAYear = await sign(
    licenseDoc({ graceUntil: V3_ISSUED + 365 * 86400 + 1 }),
  );
  const profileNotObject = await sign(licenseDoc({ profile: "grace" }));
  const noGrace = await sign(licenseDoc({ graceUntil: V3_EXPIRES }));
  const shortGrace = await sign(licenseDoc({ graceUntil: V3_ISSUED + 7200 }));
  const older = await sign(
    licenseDoc({
      issuedAt: V3_ISSUED - 1800,
      expiresAt: V3_EXPIRES - 1800,
      graceUntil: V3_GRACE - 1800,
    }),
  );
  const entitlementShapes = await sign(
    licenseDoc({
      entitlements: {
        "license.tier": {
          state: "enforced",
          value: "pro",
          updatedAt: 1699990000,
        },
        polarisVpn: { state: "enforced", value: false, updatedAt: 1699990000 },
        export: { state: "enforced", value: "true", updatedAt: 1699990000 },
        bare: true,
        hidden: { state: "hidden", value: true, updatedAt: 1699990000 },
      },
    }),
  );
  const noTier = await sign(
    licenseDoc({
      entitlements: {
        polarisVpn: { state: "enforced", value: true, updatedAt: 1699990000 },
      },
    }),
  );
  const noProfile = await sign(
    (() => {
      const d = licenseDoc();
      delete d.profile;
      return d;
    })(),
  );
  const emailOnly = await sign(
    licenseDoc({ profile: { email: "grace@example.com" } }),
  );
  const shortSubject = await sign(
    licenseDoc({ profile: { ...BASE_PROFILE, user: { subject: "ps_short" } } }),
  );
  const userNotObject = await sign(
    licenseDoc({ profile: { ...BASE_PROFILE, user: SUBJECT } }),
  );
  const subjectNotString = await sign(
    licenseDoc({ profile: { ...BASE_PROFILE, user: { subject: 7 } } }),
  );

  const L = REF_HEADER_LICENSE;
  const D = REF_HEADER_DEVICE;
  const row = (
    id: string,
    description: string,
    headers: [string, string][],
    expect: RefVerdict,
    o: {
      now?: number;
      options?: RefVerdictInput["options"];
      trust?: RefVerdictInput["trust"];
    } = {},
  ): VerdictRow => ({
    id,
    description,
    input: {
      headers,
      now: o.now ?? V3_NOW,
      options: o.options ?? opts(),
      trust: o.trust ?? TRUST_ONE,
    },
    expect,
  });
  const ent = (name: string): RefRequirement => ({ kind: "entitlement", name });
  const signIn: RefRequirement = { kind: "signIn" };
  const EXP_EDGE = V3_EXPIRES + SKEW;

  return [
    // ── Passing ────────────────────────────────────────────────────────────────────────────
    row(
      "ok",
      "A fresh licence document and no requirement",
      [[L, J]],
      pass(ctx()),
    ),
    row(
      "ok-device-header-matches",
      "X-PKey-Device equals the document's deviceId",
      [
        [L, J],
        [D, DEVICE_V3],
      ],
      pass(ctx()),
    ),
    row(
      "ok-header-names-any-case",
      "Header names are case-insensitive",
      [
        ["x-pkey-license", J],
        ["X-PKEY-DEVICE", DEVICE_V3],
      ],
      pass(ctx()),
    ),
    row(
      "ok-device-header-empty",
      "An empty X-PKey-Device has no element, so it is absent",
      [
        [L, J],
        [D, ""],
      ],
      pass(ctx()),
    ),
    row(
      "ok-value-whitespace-trimmed",
      "Spaces and tabs around an element are trimmed",
      [[L, ` \t${J} `]],
      pass(ctx()),
    ),
    row(
      "ok-at-max-bytes",
      "A valid document whose JWS is exactly 16 384 bytes",
      [[L, at16384]],
      pass(ctx()),
      at16384Kid === PIN_KID
        ? {}
        : { trust: { [AUD_V3]: { [at16384Kid]: pub(at16384Kid) } } },
    ),
    row(
      "ok-issued-at-skew-edge",
      "issuedAt is exactly now + 300: accepted, and the age is never negative",
      [[L, J]],
      pass(ctx({ now: V3_ISSUED - SKEW })),
      { now: V3_ISSUED - SKEW },
    ),
    row(
      "ok-expiry-skew-edge",
      "now is exactly expiresAt + 300 (the gate is in grace, which is usable)",
      [[L, J]],
      pass(ctx({ now: EXP_EDGE })),
      { now: EXP_EDGE },
    ),
    row(
      "ok-replayed-older-document",
      "A backend keeps no floor: an older document still inside its window passes (the declared replay window, §14.6)",
      [[L, older]],
      pass(ctx({ issuedAt: V3_ISSUED - 1800 })),
    ),
    row(
      "ok-multi-product-djdl",
      "A backend serving two products: the document's aud selects djdl, whose key signed it",
      [[L, J]],
      pass(ctx()),
      { options: opts({ products: [ACME, AUD_V3] }), trust: TRUST_TWO },
    ),
    row(
      "ok-multi-product-acme",
      "A backend serving two products: the document's aud selects acme, whose key signed it",
      [[L, acmeByAlt]],
      pass(ctx({ product: ACME })),
      { options: opts({ products: [ACME, AUD_V3] }), trust: TRUST_TWO },
    ),
    row(
      "ok-tier-absent",
      "No license.tier entitlement: tier is null",
      [[L, noTier]],
      pass(ctx({ tier: null })),
    ),
    row(
      "ok-holder-needs-name-and-email",
      "A profile without a name has no holder",
      [[L, emailOnly]],
      pass(ctx({ holder: null })),
    ),
    row(
      "ok-subject-read-without-requirement",
      "The signed-in account is attached whether or not the route requires it",
      [[L, withSubject]],
      pass(ctx({ user: { subject: SUBJECT } })),
    ),
    row(
      "ok-entitlement-true",
      "requireEntitlement(polarisVpn): its value is true",
      [[L, J]],
      pass(ctx()),
      { options: opts({ require: [ent("polarisVpn")] }) },
    ),
    row(
      "ok-entitlement-any-state",
      "An entitlement's value decides, whatever its state",
      [[L, entitlementShapes]],
      pass(ctx()),
      { options: opts({ require: [ent("hidden")] }) },
    ),
    row(
      "ok-sign-in",
      "requireSignIn(): profile.user.subject is a pairwise subject",
      [[L, withSubject]],
      pass(ctx({ user: { subject: SUBJECT } })),
      { options: opts({ require: [ent("polarisVpn"), signIn] }) },
    ),
    row(
      "ok-max-age-edge",
      "maxAgeSeconds 600: now - issuedAt is exactly 600 + 300",
      [[L, J]],
      pass(ctx({ now: V3_ISSUED + 900 })),
      { now: V3_ISSUED + 900, options: opts({ maxAgeSeconds: 600 }) },
    ),
    row(
      "ok-max-age-past-expiry",
      "maxAgeSeconds of three days accepts a document past expiresAt, inside graceUntil",
      [[L, J]],
      pass(ctx({ now: V3_ISSUED + 86400 })),
      { now: V3_ISSUED + 86400, options: opts({ maxAgeSeconds: 259200 }) },
    ),
    row(
      "ok-max-age-at-grace-until",
      "maxAgeSeconds: now is exactly graceUntil",
      [[L, shortGrace]],
      pass(ctx({ now: V3_ISSUED + 7200 })),
      { now: V3_ISSUED + 7200, options: opts({ maxAgeSeconds: 259200 }) },
    ),
    // ── Step 1: license_required ───────────────────────────────────────────────────────────
    row(
      "required-no-header",
      "No X-PKey-License",
      [],
      refused("license_required"),
    ),
    row(
      "required-empty-value",
      "An empty X-PKey-License has no element",
      [[L, ""]],
      refused("license_required"),
    ),
    row(
      "required-only-separators",
      "Commas and spaces only: no element",
      [[L, " , ,"]],
      refused("license_required"),
    ),
    row(
      "required-authorization-never-read",
      "The document in Authorization is never read",
      [["Authorization", `${REF_AUTH_SCHEME} ${J}`]],
      refused("license_required"),
    ),
    row(
      "required-device-header-alone",
      "X-PKey-Device without X-PKey-License",
      [[D, DEVICE_V3]],
      refused("license_required"),
    ),
    // ── Step 2: license_invalid (shape) ────────────────────────────────────────────────────
    row(
      "invalid-two-fields",
      "Two X-PKey-License fields, even identical ones",
      [
        [L, J],
        [L, J],
      ],
      refused("license_invalid"),
    ),
    row(
      "invalid-joined-values",
      "Two documents joined in one field (a proxy merging repeated fields)",
      [[L, `${J}, ${withSubject}`]],
      refused("license_invalid"),
    ),
    row(
      "invalid-over-max-bytes",
      "A valid document whose JWS is 16 385 bytes",
      [[L, at16385]],
      refused("license_invalid"),
      {
        trust: {
          [AUD_V3]: { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) },
        },
      },
    ),
    row(
      "invalid-two-segments",
      "Not three segments",
      [[L, `${h}.${p}`]],
      refused("license_invalid"),
    ),
    row(
      "invalid-four-segments",
      "Four segments",
      [[L, `${J}.${s}`]],
      refused("license_invalid"),
    ),
    row(
      "invalid-empty-segment",
      "An empty payload segment",
      [[L, `${h}..${s}`]],
      refused("license_invalid"),
    ),
    row(
      "invalid-padding-character",
      "A padded segment is not base64url",
      [[L, `${J}==`]],
      refused("license_invalid"),
    ),
    row(
      "invalid-inner-space",
      "A space inside the value",
      [[L, `${h}. ${p}.${s}`]],
      refused("license_invalid"),
    ),
    // ── Step 3: license_invalid (the strict verifier, issuer, product, device, issuedAt) ───
    row(
      "invalid-bad-signature",
      "One signature character changed",
      [[L, badSig]],
      refused("license_invalid"),
    ),
    row(
      "invalid-payload-swapped",
      "Another document's payload under this signature",
      [[L, tampered]],
      refused("license_invalid"),
    ),
    row(
      "invalid-foreign-key-pinned-kid",
      "Signed by a key that is not the product's, under the pinned kid",
      [[L, foreign]],
      refused("license_invalid"),
    ),
    row(
      "invalid-unknown-kid",
      "Signed by a key the trust set does not hold",
      [[L, altKid]],
      refused("license_invalid"),
    ),
    row(
      "invalid-empty-trust",
      "No key at all for the product",
      [[L, J]],
      refused("license_invalid"),
      { trust: { [AUD_V3]: {} } },
    ),
    row(
      "invalid-config-typ",
      "The licence payload signed as pkey-config+jws",
      [[L, asConfigTyp]],
      refused("license_invalid"),
    ),
    row(
      "invalid-config-document",
      "A config document is never a licence",
      [[L, configDocument]],
      refused("license_invalid"),
    ),
    row(
      "invalid-issuer",
      "iss is not key.plrs.im",
      [[L, wrongIss]],
      refused("license_invalid"),
    ),
    row(
      "invalid-unconfigured-product",
      "aud names a product this backend does not serve, signed by a key it trusts",
      [[L, acmeByPin]],
      refused("license_invalid"),
    ),
    row(
      "invalid-cross-product-key",
      "aud acme signed by djdl's key: one product's key never signs for another",
      [[L, acmeByPin]],
      refused("license_invalid"),
      { options: opts({ products: [ACME, AUD_V3] }), trust: TRUST_TWO },
    ),
    row(
      "invalid-device-mismatch",
      "X-PKey-Device names another device: the header cannot re-bind a document",
      [
        [L, J],
        [D, "dev_other"],
      ],
      refused("license_invalid"),
    ),
    row(
      "invalid-two-device-elements",
      "Two X-PKey-Device elements",
      [
        [L, J],
        [D, `${DEVICE_V3}, ${DEVICE_V3}`],
      ],
      refused("license_invalid"),
    ),
    row(
      "invalid-device-id-not-string",
      "The document's deviceId is a number",
      [[L, numericDevice]],
      refused("license_invalid"),
    ),
    row(
      "invalid-device-id-empty",
      "The document's deviceId is empty",
      [[L, emptyDevice]],
      refused("license_invalid"),
    ),
    row(
      "invalid-issued-in-future",
      "issuedAt is now + 301",
      [[L, J]],
      refused("license_invalid"),
      { now: V3_ISSUED - SKEW - 1 },
    ),
    row(
      "invalid-no-license-id",
      "The licence claims fail: no licenseId",
      [[L, noLicenseId]],
      refused("license_invalid"),
    ),
    row(
      "invalid-grace-over-a-year",
      "The licence claims fail: graceUntil is past issuedAt + 365 days",
      [[L, graceOverAYear]],
      refused("license_invalid"),
    ),
    row(
      "invalid-profile-not-object",
      "The licence claims fail: profile is a string",
      [[L, profileNotObject]],
      refused("license_invalid"),
    ),
    row(
      "invalid-before-stale",
      "Step 3 runs before step 4: an expired document with a mismatched device",
      [
        [L, J],
        [D, "dev_other"],
      ],
      refused("license_invalid"),
      { now: EXP_EDGE + 1 },
    ),
    // ── Steps 4 and 5: license_stale ───────────────────────────────────────────────────────
    row(
      "stale-expired",
      "now is expiresAt + 301",
      [[L, J]],
      refused("license_stale"),
      { now: EXP_EDGE + 1 },
    ),
    row(
      "stale-replayed-after-window",
      "A captured document replayed after its window",
      [[L, older]],
      refused("license_stale"),
      { now: V3_EXPIRES - 1800 + SKEW + 1 },
    ),
    row(
      "stale-max-age",
      "maxAgeSeconds 600: now - issuedAt is 901, though expiresAt is an hour out",
      [[L, J]],
      refused("license_stale"),
      { now: V3_ISSUED + 901, options: opts({ maxAgeSeconds: 600 }) },
    ),
    row(
      "stale-max-age-zero",
      "maxAgeSeconds 0: now - issuedAt is 301",
      [[L, J]],
      refused("license_stale"),
      { now: V3_ISSUED + 301, options: opts({ maxAgeSeconds: 0 }) },
    ),
    row(
      "stale-max-age-past-grace-until",
      "maxAgeSeconds never reaches past graceUntil",
      [[L, shortGrace]],
      refused("license_stale"),
      { now: V3_ISSUED + 7201, options: opts({ maxAgeSeconds: 259200 }) },
    ),
    row(
      "stale-gate-expired",
      "Step 5: inside expiresAt + 300, but graceUntil equals expiresAt, so the gate says expired",
      [[L, noGrace]],
      refused("license_stale"),
      { now: V3_EXPIRES + 100 },
    ),
    row(
      "stale-before-requirements",
      "Step 4 runs before step 6",
      [[L, J]],
      refused("license_stale"),
      {
        now: EXP_EDGE + 1,
        options: opts({ require: [ent("export"), signIn] }),
      },
    ),
    // ── Step 6: not_entitled and sign_in_required ──────────────────────────────────────────
    row(
      "forbidden-entitlement-missing",
      "requireEntitlement(export): the document has no such entitlement",
      [[L, J]],
      refused("not_entitled", ctx()),
      { options: opts({ require: [ent("export")] }) },
    ),
    row(
      "forbidden-entitlement-false",
      "The entitlement's value is false",
      [[L, entitlementShapes]],
      refused("not_entitled", ctx()),
      { options: opts({ require: [ent("polarisVpn")] }) },
    ),
    row(
      "forbidden-entitlement-string-true",
      'The entitlement\'s value is the string "true"',
      [[L, entitlementShapes]],
      refused("not_entitled", ctx()),
      { options: opts({ require: [ent("export")] }) },
    ),
    row(
      "forbidden-entitlement-not-boolean",
      "license.tier is a string, never an entitlement that is true",
      [[L, J]],
      refused("not_entitled", ctx()),
      { options: opts({ require: [ent("license.tier")] }) },
    ),
    row(
      "forbidden-entitlement-entry-not-object",
      "An entry that is a bare true, not a managed entry",
      [[L, entitlementShapes]],
      refused("not_entitled", ctx()),
      { options: opts({ require: [ent("bare")] }) },
    ),
    row(
      "forbidden-entitlement-prototype-name",
      "An inherited member name is no entitlement",
      [[L, J]],
      refused("not_entitled", ctx()),
      { options: opts({ require: [ent("__proto__")] }) },
    ),
    row(
      "forbidden-entitlement-constructor",
      "An inherited member name is no entitlement",
      [[L, J]],
      refused("not_entitled", ctx()),
      { options: opts({ require: [ent("constructor")] }) },
    ),
    row(
      "forbidden-sign-in-no-user",
      "requireSignIn(): the document names no account",
      [[L, J]],
      refused("sign_in_required", ctx()),
      { options: opts({ require: [signIn] }) },
    ),
    row(
      "forbidden-sign-in-no-profile",
      "requireSignIn(): the document has no profile",
      [[L, noProfile]],
      refused("sign_in_required", ctx({ holder: null })),
      { options: opts({ require: [signIn] }) },
    ),
    row(
      "forbidden-sign-in-malformed-subject",
      "requireSignIn(): the subject is not a pairwise subject",
      [[L, shortSubject]],
      refused("sign_in_required", ctx()),
      { options: opts({ require: [signIn] }) },
    ),
    row(
      "forbidden-sign-in-user-not-object",
      "requireSignIn(): profile.user is a string",
      [[L, userNotObject]],
      refused("sign_in_required", ctx()),
      { options: opts({ require: [signIn] }) },
    ),
    row(
      "forbidden-sign-in-subject-not-string",
      "requireSignIn(): the subject is a number",
      [[L, subjectNotString]],
      refused("sign_in_required", ctx()),
      { options: opts({ require: [signIn] }) },
    ),
    row(
      "forbidden-requirements-in-order",
      "Requirements run in route order: the entitlement first",
      [[L, J]],
      refused("not_entitled", ctx()),
      { options: opts({ require: [ent("export"), signIn] }) },
    ),
    row(
      "forbidden-requirements-in-order-reversed",
      "Requirements run in route order: sign-in first",
      [[L, J]],
      refused("sign_in_required", ctx()),
      { options: opts({ require: [signIn, ent("export")] }) },
    ),
  ];
}

interface ProblemRow {
  id: string;
  input: { code: RefBackendCode; acceptLanguage: string | null; realm: string };
  expect: RefProblem;
}

type CopyCodes = Record<
  string,
  Record<string, { title: string; message: string }>
>;

function readCopy(): CopyCodes {
  const out: CopyCodes = {};
  for (const locale of REF_LOCALES) {
    const doc = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "conformance", "parity", `copy.${locale}.json`),
        "utf8",
      ),
    ) as { locale: string; codes: CopyCodes[string] };
    if (doc.locale !== locale)
      throw new Error(`backend-matrix: copy.${locale}.json says ${doc.locale}`);
    out[locale] = doc.codes;
  }
  return out;
}

function problemRows(copy: CopyCodes): ProblemRow[] {
  const expectOf = (
    code: RefBackendCode,
    locale: RefLocale,
    realm = AUD_V3,
  ): RefProblem => {
    const status = REF_BACKEND_STATUS[code];
    const entry = copy[locale]![code];
    if (!entry)
      throw new Error(`backend-matrix: copy.${locale}.json has no ${code}`);
    return {
      status,
      locale,
      challenge:
        status === 401
          ? `${REF_AUTH_SCHEME} realm="${realm}", error="${code}"`
          : null,
      type: `${REF_TYPE_BASE}${code}`,
      title: entry.title,
      detail: entry.message,
    };
  };
  const rows: ProblemRow[] = [];
  for (const code of Object.keys(REF_BACKEND_STATUS) as RefBackendCode[])
    for (const locale of REF_LOCALES)
      rows.push({
        id: `${code}-${locale}`,
        input: { code, acceptLanguage: locale, realm: AUD_V3 },
        expect: expectOf(code, locale),
      });
  const neg = (
    id: string,
    acceptLanguage: string | null,
    locale: RefLocale,
    code: RefBackendCode = "license_stale",
    realm = AUD_V3,
  ) =>
    rows.push({
      id,
      input: { code, acceptLanguage, realm },
      expect: expectOf(code, locale, realm),
    });
  neg("locale-absent", null, "en");
  neg("locale-empty", "", "en");
  neg("locale-any", "*", "en");
  neg("locale-without-pack", "fr", "en");
  neg("locale-region-subtag", "de-AT", "de");
  neg("locale-case-insensitive", "PT-br", "pt-BR");
  neg("locale-portuguese-portugal", "pt-PT", "pt-BR");
  neg("locale-chinese-simplified-region", "zh-CN", "zh-Hans");
  neg("locale-chinese-bare", "zh", "zh-Hans");
  neg("locale-chinese-traditional", "zh-TW", "en");
  neg("locale-chinese-hant-then-zh", "zh-Hant-TW, zh;q=0.5", "zh-Hans");
  neg("locale-next-range-when-no-pack", "fr-CA, fr;q=0.9, de;q=0.8", "de");
  neg("locale-weight-order", "en-GB;q=0.5, ja;q=0.9", "ja");
  neg("locale-weight-tie-keeps-order", "it;q=0.5, es;q=0.5", "it");
  neg("locale-weight-zero-dropped", "ja;q=0, ko", "ko");
  neg("locale-bad-weight-dropped", "ja;q=2, ko;q=abc, de", "de");
  neg("locale-first-weight-counts", "de;q=0.1;q=1, es;q=0.5", "es");
  neg("locale-other-parameter-ignored", "ko;level=1", "ko");
  neg("locale-star-after-unmatched", "fr, *;q=0.5, de;q=0.1", "en");
  neg("locale-whitespace", " \tja ; q=0.8 ,de;q=0.7", "ja");
  neg("locale-underscore-no-match", "de_DE", "en");
  neg("realm-of-another-product", "en", "en", "license_required", ACME);
  neg("not-entitled-has-no-challenge", "de", "de", "not_entitled", ACME);
  return rows;
}

interface ClientRow {
  id: string;
  input: RefClientInput;
  expect: { action: RefClientAction };
}

function clientRows(): ClientRow[] {
  const doc = { issuedAt: V3_ISSUED, expiresAt: V3_EXPIRES };
  const row = (
    id: string,
    input: Partial<RefClientInput>,
    action: RefClientAction,
  ): ClientRow => ({
    id,
    input: {
      document: input.document === undefined ? doc : input.document,
      now: input.now ?? V3_NOW,
      response: input.response ?? null,
      retried: input.retried ?? false,
    },
    expect: { action },
  });
  const edge = V3_EXPIRES - REF_REFRESH_MARGIN;
  const r = (status: number, code: string | null) => ({ status, code });
  return [
    row("send-fresh", {}, "send"),
    row("send-at-margin-edge", { now: edge }, "send"),
    row("refresh-past-margin", { now: edge + 1 }, "refresh-then-send"),
    row("refresh-expired", { now: V3_EXPIRES + 10 }, "refresh-then-send"),
    row("send-no-document", { document: null }, "send"),
    row("send-ignores-retried", { retried: true }, "send"),
    row(
      "retry-on-stale",
      { response: r(401, "license_stale") },
      "refresh-and-retry",
    ),
    row(
      "retry-on-invalid",
      { response: r(401, "license_invalid") },
      "refresh-and-retry",
    ),
    row(
      "retry-without-a-document",
      { document: null, response: r(401, "license_invalid") },
      "refresh-and-retry",
    ),
    row(
      "surface-after-one-retry",
      { response: r(401, "license_stale"), retried: true },
      "surface",
    ),
    row(
      "surface-required",
      { response: r(401, "license_required") },
      "surface",
    ),
    row(
      "surface-not-entitled",
      { response: r(403, "not_entitled") },
      "surface",
    ),
    row(
      "surface-sign-in-required",
      { response: r(403, "sign_in_required") },
      "surface",
    ),
    row("surface-success", { response: r(200, null) }, "surface"),
    row("surface-401-without-code", { response: r(401, null) }, "surface"),
    row(
      "surface-stale-code-wrong-status",
      { response: r(403, "license_stale") },
      "surface",
    ),
    row("surface-server-error", { response: r(500, null) }, "surface"),
  ];
}

export async function buildBackendMatrixV1(): Promise<unknown> {
  if (!REF_SUBJECT_RE.test(SUBJECT))
    throw new Error(
      "backend-matrix: the fixture subject is not a pairwise subject",
    );
  const copy = readCopy();
  const verdict = await verdictRows();
  const problem = problemRows(copy);
  const client = clientRows();
  const ids = new Set<string>();
  const unique = (section: string, id: string) => {
    if (ids.has(`${section}/${id}`))
      throw new Error(`backend-matrix: two ${section} rows are ${id}`);
    ids.add(`${section}/${id}`);
  };
  for (const r of verdict) {
    unique("verdict", r.id);
    const got = refBackendVerdict(r.input);
    if (JSON.stringify(got) !== JSON.stringify(r.expect))
      throw new Error(
        `backend-matrix: verdict ${r.id} is ${JSON.stringify(got)}, the row says ${JSON.stringify(r.expect)}`,
      );
  }
  for (const r of problem) {
    unique("problem", r.id);
    const got = refBackendProblem(r.input, copy);
    if (JSON.stringify(got) !== JSON.stringify(r.expect))
      throw new Error(
        `backend-matrix: problem ${r.id} is ${JSON.stringify(got)}, the row says ${JSON.stringify(r.expect)}`,
      );
  }
  for (const r of client) {
    unique("client", r.id);
    const got = refClientBackendAction(r.input);
    if (got !== r.expect.action)
      throw new Error(
        `backend-matrix: client ${r.id} is ${got}, the row says ${r.expect.action}`,
      );
  }
  // Every code is reached by a verdict row, and every action by a client row.
  for (const code of Object.keys(REF_BACKEND_STATUS))
    if (!verdict.some((r) => r.expect.code === code))
      throw new Error(`backend-matrix: no verdict row answers ${code}`);
  for (const action of [
    "send",
    "refresh-then-send",
    "refresh-and-retry",
    "surface",
  ])
    if (!client.some((r) => r.expect.action === action))
      throw new Error(`backend-matrix: no client row answers ${action}`);
  // The two size rows straddle the cap exactly.
  const size = (id: string) =>
    verdict.find((r) => r.id === id)!.input.headers[0]![1].length;
  if (size("ok-at-max-bytes") !== REF_LICENSE_MAX_BYTES)
    throw new Error("backend-matrix: ok-at-max-bytes is not 16 384 bytes");
  if (size("invalid-over-max-bytes") !== REF_LICENSE_MAX_BYTES + 1)
    throw new Error(
      "backend-matrix: invalid-over-max-bytes is not 16 385 bytes",
    );
  return {
    backendMatrixVersion: 1,
    description:
      "Product backends (WIRE-CONTRACT-V4 §14, plans/SP-53.md §4). `verdict` pins §14.2's six steps: a row's `input` is the request's header fields in order as [name, value] pairs, `now` (the server's clock, epoch seconds), `options` ({products: the configured product slugs in order, maxAgeSeconds when set, require: the route's requirements in order, each {kind: \"entitlement\", name} or {kind: \"signIn\"}}) and `trust` (per product, kid -> base64url Ed25519 key: the pins plus the last verified trust manifest's keys); `expect` is {status, code, context}, where status is 200 with code null when every step passes, and context is the attached licence and account whenever steps 1 to 5 pass (step 6's refusals included) and null otherwise. A header's elements are every field with its name (any case), each value split at `,`, each element trimmed of spaces and tabs, empty ones dropped. `problem` pins §14.3: {code, acceptLanguage, realm} -> {status, locale, challenge (the WWW-Authenticate value on a 401, else null), type, title, detail}; the body is {type, title, status, detail, code} with Content-Type application/problem+json and Cache-Control no-store, and title and detail are copy.<locale>.json's `codes` entry. `client` pins §14.5: {document ({issuedAt, expiresAt} or null), now (the client's effective time), response ({status, code: the problem body's code or null} or null before sending), retried} -> {action}. Non-ASCII is written escaped.",
    constants: {
      headerLicense: REF_HEADER_LICENSE,
      headerDevice: REF_HEADER_DEVICE,
      licenseMaxBytes: REF_LICENSE_MAX_BYTES,
      clockSkewSeconds: SKEW,
      refreshMarginSeconds: REF_REFRESH_MARGIN,
      authScheme: REF_AUTH_SCHEME,
      subjectPattern: REF_SUBJECT_RE.source,
      typeBase: REF_TYPE_BASE,
      contentType: "application/problem+json",
      cacheControl: "no-store",
      locales: [...REF_LOCALES],
      statuses: REF_BACKEND_STATUS,
    },
    verdict,
    problem,
    client,
  };
}
