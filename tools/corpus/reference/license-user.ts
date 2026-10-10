// Reference: the licence document's signed-in subject (WIRE-CONTRACT-V4 §2.1, §3.2,
// plans/SP-54.md §2): `profile.user`, read beside the claims and never refusing a document.
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: it imports nothing it checks. The pattern is a literal.

import { hasOwn, isObj } from "./claims.js";

/** §8: the pairwise subject, matched whole with ASCII classes (§3.3 rule 1). */
export const REF_SUBJECT_RE = /^ps_[A-Za-z0-9_-]{22}$/;

/**
 * §3.2: `{subject}` when `profile` is an object, its own `user` is an object and that object's
 * own `subject` is a string that wholly matches the pattern; `null` otherwise. Unknown members
 * of `user` are ignored.
 */
export function refLicenseUserOf(doc: unknown): { subject: string } | null {
  if (!isObj(doc) || !hasOwn(doc, "profile")) return null;
  const profile = doc.profile;
  if (!isObj(profile) || !hasOwn(profile, "user")) return null;
  const user = profile.user;
  if (!isObj(user) || !hasOwn(user, "subject")) return null;
  const subject = user.subject;
  return typeof subject === "string" && REF_SUBJECT_RE.test(subject)
    ? { subject }
    : null;
}
