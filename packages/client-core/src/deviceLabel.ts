// The device label (WIRE-CONTRACT-V4 §12.7.1), pinned by `device-label.json`.
//
// A device reports a human label ("Living room TV") on device-code sign-in, licence activation
// and registration, under the wire member `deviceName`. It is display data: no server decision
// reads it, and the sign-in card frames it as "reported by the device". This is the reference
// implementation of the one normalisation every SDK applies before sending and the Worker applies
// on receipt:
//
//   1. map the whitespace controls of `DISPLAY_TEXT_SPACE` to U+0020;
//   2. delete the controls, zero-width and bidi code points of `DISPLAY_TEXT_STRIP`;
//   3. collapse runs of U+0020 to one, then trim U+0020 from both ends;
//   4. keep at most `DEVICE_LABEL_MAX_CODEPOINTS` code points (code points, never UTF-16 units);
//   5. an empty result is no label at all: `null`, and the member is omitted.
//
// There is no Unicode normalisation step (Godot has no normaliser), and nothing is ever
// rejected — a label is only ever normalised.

import {
  DEVICE_LABEL_MAX_CODEPOINTS,
  DISPLAY_TEXT_SPACE,
  DISPLAY_TEXT_STRIP,
} from "@polaris-key/protocol/identity";

function inRanges(
  cp: number,
  ranges: readonly (readonly [number, number])[],
): boolean {
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
}

/** §12.7.1: the label to send and store, or `null` when nothing is left of `raw`. */
export function normalizeDeviceLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const kept: number[] = [];
  for (const ch of raw) {
    let cp = ch.codePointAt(0)!;
    if (inRanges(cp, DISPLAY_TEXT_SPACE)) cp = 0x20;
    else if (inRanges(cp, DISPLAY_TEXT_STRIP)) continue;
    // Step 3, collapsing as it goes: a space never follows a space or starts the label.
    if (cp === 0x20 && (kept.length === 0 || kept[kept.length - 1] === 0x20))
      continue;
    kept.push(cp);
  }
  while (kept.length > 0 && kept[kept.length - 1] === 0x20) kept.pop();
  // Step 4 after the trim, then trim again: a cut can leave a trailing space.
  const cut = kept.slice(0, DEVICE_LABEL_MAX_CODEPOINTS);
  while (cut.length > 0 && cut[cut.length - 1] === 0x20) cut.pop();
  return cut.length === 0 ? null : String.fromCodePoint(...cut);
}
