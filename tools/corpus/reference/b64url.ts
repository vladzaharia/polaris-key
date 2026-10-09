// Reference: canonical base64url (V4 §1).
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: re-encoding the decoded bytes (Node's own `base64url`
// codec, not the verifier's) must give the input back.

/** The alphabet, no padding, never a length of 1 mod 4, and zero unused low bits in the last
 *  character. */
export function refCanonicalB64url(s: string): boolean {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return false;
  return Buffer.from(s, "base64url").toString("base64url") === s;
}
