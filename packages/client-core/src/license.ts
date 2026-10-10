// Members of the licence document read beside the claims (WIRE-CONTRACT-V4 §2.1, §3.2).
//
//   licenseUserOf   `profile.user`, the person signed in on the device (SP-54)
//
// A verifier never checks these members: a document verifies or not on its claims alone, and a
// malformed member here is simply absent. Each reader is total over any value, so it can run on
// a verified payload, a cached one, or one a server received in `X-PKey-License` (§14.2 step 6).

import { PAIRWISE_SUBJECT_PATTERN } from "@polaris-key/protocol/core";
import type { SignedInUser } from "@polaris-key/protocol/license";
import { hasOwn } from "./own.js";

const SUBJECT = new RegExp(PAIRWISE_SUBJECT_PATTERN);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * §2.1, §3.2: the account signed in on the device the document was issued to, or `null` when
 * none is. `{subject}` only when `profile` is an object, its `user` is an object, and that
 * object's own `subject` is a string that wholly matches `PAIRWISE_SUBJECT_PATTERN` (§3.3 rule 1:
 * no trailing line terminator, ASCII classes only). Anything else, including a missing
 * `profile`, is `null`. Unknown members of `user` are ignored. Never throws.
 */
export function licenseUserOf(doc: unknown): SignedInUser | null {
  if (!isPlainObject(doc) || !hasOwn(doc, "profile")) return null;
  const profile = doc.profile;
  if (!isPlainObject(profile) || !hasOwn(profile, "user")) return null;
  const user = profile.user;
  if (!isPlainObject(user) || !hasOwn(user, "subject")) return null;
  const subject = user.subject;
  return typeof subject === "string" && SUBJECT.test(subject)
    ? { subject }
    : null;
}
