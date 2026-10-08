// Reference: the device label (WIRE-CONTRACT-V4 §12.7.1).
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: the family modules recompute every verdict through it.

/** The generator's own §12.7.1 reference, written with regular expressions on purpose. */
export function refDeviceLabel(raw: string): string | null {
  const spaced = raw.replace(
    /[\u0009-\u000d\u0085\u00a0\u2028\u2029\u3000]/gu,
    " ",
  );
  const stripped = spaced.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu,
    "",
  );
  const collapsed = stripped.replace(/ +/g, " ").replace(/^ | $/g, "");
  const cut = Array.from(collapsed).slice(0, 64).join("").replace(/ $/, "");
  return cut === "" ? null : cut;
}
