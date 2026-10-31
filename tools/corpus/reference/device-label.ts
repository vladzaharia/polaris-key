// Reference: the device label (WIRE-CONTRACT-V5 §12.7.1) and the HELLO label (§15.6).
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: the family modules recompute every verdict through it. The
// character classes below are regular-expression literals on purpose; the module that builds
// the corpus holds the same sets as `ranges` integer pairs, and compares the two code point by
// code point, so neither can drift from the other.

/** Step 1: every White_Space code point except U+0020, and U+2800 BRAILLE PATTERN BLANK. */
const SPACE_CLASS =
  /[\u0009-\u000d\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u2800\u3000]/gu;

/**
 * Step 2: Cc, Cf, Default_Ignorable_Code_Point and Cs as of Unicode 16.0. The C0 and C1 ranges
 * hold the controls step 1 has already mapped (U+0009-000D, U+0085); they are listed whole so
 * the table reads as the property.
 */
const STRIP_CLASS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u0600-\u0605\u061c\u06dd\u070f\u0890\u0891\u08e2\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ud800-\udfff\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\u{110bd}\u{110cd}\u{13430}-\u{1343f}\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/gu;

/** True when the reference maps `cp` to a space (step 1; U+0020 itself is not in the table). */
export function refIsSpace(cp: number): boolean {
  SPACE_CLASS.lastIndex = 0;
  return SPACE_CLASS.test(String.fromCodePoint(cp));
}

/** True when the reference deletes `cp` (step 2). */
export function refIsStrip(cp: number): boolean {
  STRIP_CLASS.lastIndex = 0;
  return STRIP_CLASS.test(String.fromCodePoint(cp));
}

function steps1and2(raw: string): string {
  return raw.replace(SPACE_CLASS, " ").replace(STRIP_CLASS, "");
}

function steps3to5(s: string): string | null {
  const collapsed = s.replace(/ +/g, " ").replace(/^ | $/g, "");
  const cut = Array.from(collapsed).slice(0, 64).join("").replace(/ $/, "");
  return cut === "" ? null : cut;
}

/** The generator's own §12.7.1 reference (no NFC), written with regular expressions on purpose. */
export function refDeviceLabel(raw: string): string | null {
  return steps3to5(steps1and2(raw));
}

/**
 * The generator's own §15.6 reference for a HELLO `label` or `app`: steps 1 and 2, then NFC,
 * then steps 3 to 5. The NFC sits between them so that cleaning twice changes nothing.
 */
export function refHelloLabel(raw: string): string | null {
  return steps3to5(steps1and2(raw).normalize("NFC"));
}
