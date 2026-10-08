// Reference: the header value fold (§5.2).
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: the family modules recompute every verdict through it.

/** ASCII case folding: A–Z become a–z, every other code unit is unchanged (§5.2 rule 1). */
export function refFoldAscii(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 0x20) : raw[i];
  }
  return out;
}
