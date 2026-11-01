// The device label (WIRE-CONTRACT-V5 §12.7.1), pinned by `device-label.json`.
//
// A device reports a human label ("Living room TV") on device-code sign-in, licence activation
// and registration, under the wire member `deviceName`. It is display data: no server decision
// reads it, and the sign-in card frames it as "reported by the device". This is the reference
// implementation of the one normalisation every SDK applies before sending and the Worker applies
// on receipt:
//
//   1. map the code points of `DEVICE_LABEL_SPACE` (White_Space and U+2800) to U+0020;
//   2. delete the code points of `DEVICE_LABEL_STRIP` (controls, format characters,
//      default-ignorable code points and surrogates);
//   3. collapse runs of U+0020 to one, then trim U+0020 from both ends;
//   4. keep at most `DEVICE_LABEL_MAX_CODEPOINTS` code points (code points, never UTF-16 units);
//   5. an empty result is no label at all: `null`, and the member is omitted.
//
// There is no Unicode normalisation step (Godot has no normaliser), and nothing is ever
// rejected — a label is only ever normalised. Cleaning a cleaned label changes nothing.
//
// A peer's HELLO `label` and `app` (§15.6) are cleaned by `cleanDisplayLabel`: steps 1 and 2, NFC,
// then steps 3 to 5. NFC sits between them, not first, so that deleting a code point cannot
// bring a base and a combining mark together for a second pass to compose.

import {
  DEVICE_LABEL_MAX_CODEPOINTS,
  DEVICE_LABEL_SPACE,
  DEVICE_LABEL_STRIP,
} from "@polaris-key/protocol/identity";

function inRanges(
  cp: number,
  ranges: readonly (readonly [number, number])[],
): boolean {
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
}

/** Steps 1 and 2: the code points that survive, spaces mapped. A lone surrogate is deleted. */
function mapAndStrip(raw: string): number[] {
  const out: number[] = [];
  for (const ch of raw) {
    const cp = ch.codePointAt(0)!;
    if (inRanges(cp, DEVICE_LABEL_SPACE)) out.push(0x20);
    else if (!inRanges(cp, DEVICE_LABEL_STRIP)) out.push(cp);
  }
  return out;
}

/** Steps 3 to 5 over the code points steps 1 and 2 left. */
function collapseAndCut(
  cps: readonly number[],
  max: number = DEVICE_LABEL_MAX_CODEPOINTS,
): string | null {
  const kept: number[] = [];
  for (const cp of cps) {
    // Step 3, collapsing as it goes: a space never follows a space or starts the label.
    if (cp === 0x20 && (kept.length === 0 || kept[kept.length - 1] === 0x20))
      continue;
    kept.push(cp);
  }
  while (kept.length > 0 && kept[kept.length - 1] === 0x20) kept.pop();
  // Step 4 after the trim, then trim again: a cut can leave a trailing space.
  const cut = kept.slice(0, max);
  while (cut.length > 0 && cut[cut.length - 1] === 0x20) cut.pop();
  return cut.length === 0 ? null : String.fromCodePoint(...cut);
}

/** §12.7.1: the label to send and store, or `null` when nothing is left of `raw`. */
export function normalizeDeviceLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return collapseAndCut(mapAndStrip(raw));
}

/**
 * §15.6: a peer's HELLO `label` or `app`, or a vouch's label: steps 1 and 2 of §12.7.1, NFC, then
 * steps 3 to 5 (`device-label.json` `helloCases`). `null` when nothing is left. The 64 code points
 * are counted after NFC, which can lengthen a string (U+0958 becomes two) or shorten it.
 */
export function cleanDisplayLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let text = "";
  for (const cp of mapAndStrip(raw)) text += String.fromCodePoint(cp);
  const composed = text.normalize("NFC");
  return collapseAndCut(Array.from(composed, (c) => c.codePointAt(0)!));
}

/**
 * §15.11: a transfer's `name` as shown. Cleaned as a HELLO label (steps 1 and 2, NFC, then steps
 * 3 and 5) without the 64 code point cut. `null` when nothing is left. Display data only.
 */
export function cleanDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let text = "";
  for (const cp of mapAndStrip(raw)) text += String.fromCodePoint(cp);
  return collapseAndCut(
    Array.from(text.normalize("NFC"), (c) => c.codePointAt(0)!),
    Infinity,
  );
}
