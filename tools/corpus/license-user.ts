// `cases.json#/licenseUserCases` (plans/SP-54.md §4): the signed-in subject, `profile.user`,
// read beside the claims (WIRE-CONTRACT-V4 §2.1, §3.2). Each row is a licence document that
// verifies on the control's claims, and `expect.user` is what `licenseUserOf` reads from it:
// `{subject}` or `null`. The member never refuses a document. I-24a later adds `namedUsers` to
// `expect` and its own rows; a runner ignores an absent `expect.namedUsers`.

import {
  AUD_V3,
  DEVICE_V3,
  ISSUER_V3,
  licenseDoc,
  PIN_KID,
  pub,
  signAs,
  type TypV3,
  V3_NOW,
} from "./common.js";
import { profileWithUser, SIGNED_IN_SUBJECT } from "./claims.js";
import { ctxOf, refDocClaims } from "./reference/claims.js";
import { refVerifyJws } from "./reference/jws.js";
import { refLicenseUserOf } from "./reference/license-user.js";
import { payloadTextOf, refNonWire } from "./reference/tokens.js";

export const LICENSE_USER_CASES_COUNT = 14;

export interface LicenseUserCase {
  id: string;
  description: string;
  jws: string;
  trust: Record<string, string>;
  typ: TypV3;
  expectedAud: string;
  expectedIss: string;
  deviceId: string;
  now: number;
  expect: { accept: true; user: { subject: string } | null };
}

/** The member a row puts in the control's `profile`; `absent` removes `user`, `noProfile`
 *  removes `profile` itself. */
type Shape = { user: unknown } | "absent" | "noProfile";

export async function buildLicenseUserCases(): Promise<LicenseUserCase[]> {
  const typ: TypV3 = "pkey-license+jws";
  const trust = { [PIN_KID]: pub(PIN_KID) };
  const opts = { expectedAud: AUD_V3, deviceId: DEVICE_V3, now: V3_NOW };
  const docFor = (shape: Shape): Record<string, unknown> => {
    if (shape === "noProfile") {
      const d = licenseDoc();
      delete d.profile;
      return d;
    }
    if (shape === "absent") return licenseDoc();
    return licenseDoc({ profile: profileWithUser(shape.user) });
  };
  const mk = async (
    id: string,
    description: string,
    shape: Shape,
    user: { subject: string } | null,
  ): Promise<LicenseUserCase> => {
    const jws = await signAs(docFor(shape), PIN_KID, typ);
    // Every row verifies on the control's claims: `profile.user` decides nothing (§3.2).
    const v = refVerifyJws(jws, trust, typ);
    if (!v) throw new Error(`licenseUserCases ${id}: does not verify`);
    if (!refDocClaims(typ, v.payload, ctxOf(v.text), opts))
      throw new Error(`licenseUserCases ${id}: fails the licence claims`);
    if (refNonWire(payloadTextOf(jws)!).length !== 0)
      throw new Error(`licenseUserCases ${id}: carries a non-wire number`);
    // The reference reader agrees with the row's intent.
    const read = refLicenseUserOf(v.payload);
    if (JSON.stringify(read) !== JSON.stringify(user))
      throw new Error(
        `licenseUserCases ${id}: reads ${JSON.stringify(read)}, not ${JSON.stringify(user)}`,
      );
    return {
      id,
      description,
      jws,
      trust,
      typ,
      expectedAud: AUD_V3,
      expectedIss: ISSUER_V3,
      deviceId: DEVICE_V3,
      now: V3_NOW,
      expect: { accept: true, user },
    };
  };
  const S = SIGNED_IN_SUBJECT;
  const signedIn = { subject: S };
  const cases = [
    await mk(
      "user-valid",
      "The control: `profile.user` is an object whose `subject` wholly matches `^ps_[A-Za-z0-9_-]{22}$`, so the device's signed-in account reads as that subject.",
      { user: { subject: S } },
      signedIn,
    ),
    await mk(
      "user-no-profile",
      "No `profile` at all (V4 §3.2: absent or an object). A document without a profile names no signed-in user.",
      "noProfile",
      null,
    ),
    await mk(
      "user-profile-without-user",
      "A `profile` without `user`: what the Worker signs for a key-entry or open-enrolment device, and in every offline bundle. No signed-in user.",
      "absent",
      null,
    ),
    await mk(
      "user-null",
      "`profile.user` is `null`. The document verifies (nothing inside `profile` is a claim) and reads as no signed-in user.",
      { user: null },
      null,
    ),
    await mk(
      "user-array",
      "`profile.user` is an array holding a valid user object. An array is not an object, so no signed-in user.",
      { user: [{ subject: S }] },
      null,
    ),
    await mk(
      "user-string",
      "`profile.user` is the subject string itself, not an object holding it. No signed-in user.",
      { user: S },
      null,
    ),
    await mk(
      "user-subject-missing",
      "`profile.user` is an empty object: no `subject`. No signed-in user.",
      { user: {} },
      null,
    ),
    await mk(
      "user-subject-number",
      "`profile.user.subject` is a number, not a string. No signed-in user.",
      { user: { subject: 7 } },
      null,
    ),
    await mk(
      "user-subject-21-chars",
      "`ps_` and 21 base64url characters, one short of the pattern's 22. No signed-in user.",
      { user: { subject: S.slice(0, -1) } },
      null,
    ),
    await mk(
      "user-subject-23-chars",
      "`ps_` and 23 base64url characters, one over. A pattern that matches a prefix rather than the whole string reads a subject here (V4 §3.3 rule 1). No signed-in user.",
      { user: { subject: `${S}A` } },
      null,
    ),
    await mk(
      "user-subject-trailing-newline",
      "The valid subject followed by `\\n`. A `$` that matches before a final line terminator (Python `re.match`, Swift without `\\z`) reads a subject here; a whole-string match does not (V4 §3.3 rule 1). No signed-in user.",
      { user: { subject: `${S}\n` } },
      null,
    ),
    await mk(
      "user-subject-non-ascii-digit",
      "One character of the subject is U+0664 ARABIC-INDIC DIGIT FOUR, still 22 code points after `ps_`. A Unicode `\\d` or `\\w` reads a subject here; the pattern's classes are ASCII (V4 §3.3 rule 1). No signed-in user.",
      { user: { subject: S.replace("4", "٤") } },
      null,
    ),
    await mk(
      "user-subject-prefix-us",
      "`us_` and 22 base64url characters: the right length and alphabet under the wrong prefix. No signed-in user.",
      { user: { subject: `us_${S.slice(3)}` } },
      null,
    ),
    await mk(
      "user-extra-members-ignored",
      "`profile.user` with members beside `subject`. A reader ignores them, so the device's signed-in account still reads as the subject alone.",
      { user: { subject: S, future: { member: true }, tag: "x" } },
      signedIn,
    ),
  ];
  if (cases.length !== LICENSE_USER_CASES_COUNT)
    throw new Error(
      `licenseUserCases: ${cases.length} != ${LICENSE_USER_CASES_COUNT}`,
    );
  return cases;
}
