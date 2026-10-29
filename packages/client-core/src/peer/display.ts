// WIRE-CONTRACT-V5 §15.6 and §15.6.1: display data from a peer that is not yet verified (a mode v
// or p HELLO, a `VOUCH_REQ`) is cleaned the same way wherever it is read. One module, so the
// session and the vouch codecs cannot drift apart.

import { normalizeDeviceLabel } from "../deviceLabel.js";

/** `platform` is shown as sent only when it is up to 32 of these characters. */
const PLATFORM_DISPLAY = /^[A-Za-z0-9 ._+-]{1,32}$/;
export const UNKNOWN_DISPLAY = "Unknown";

/** NFC, then the device-label cleaning (§12.7.1): `null` when nothing is left. */
export const cleanLabel = (raw: string): string | null =>
  normalizeDeviceLabel(raw.normalize("NFC"));

/** The platform as sent when it is up to 32 plain characters, else "Unknown". */
export const cleanPlatform = (raw: string): string =>
  PLATFORM_DISPLAY.test(raw) ? raw : UNKNOWN_DISPLAY;

/** The app name, cleaned like a label; "Unknown" when nothing is left. */
export const cleanApp = (raw: string): string =>
  cleanLabel(raw) ?? UNKNOWN_DISPLAY;
