// `qr.svg(text)` and `qr.terminal(text)` (SDK parity pass §3.12): render a device-code
// `verificationUriComplete` for a phone to scan, as an SVG element or as text a terminal prints.

import { encodeQr, qrRows, type QrCode } from "./encoder.js";

export {
  encodeQr,
  encodeQrBytes,
  qrCapacity,
  qrRows,
  QR_MAX_VERSION,
  QR_MIN_VERSION,
  type QrCode,
} from "./encoder.js";

const QUIET = 2;

function moduleAt(code: QrCode, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= code.size || y >= code.size) return false;
  return code.modules[y * code.size + x] === 1;
}

/** Escape text for an XML attribute. */
function attr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export const qr = {
  /**
   * The symbol as a standalone SVG document string: one `<path>` of unit squares inside a
   * four-module light quiet zone. Null when the text does not fit version 10 (213 bytes).
   */
  svg(
    text: string,
    opts: { label?: string; dark?: string; light?: string } = {},
  ): string | null {
    const code = encodeQr(text);
    if (!code) return null;
    const n = code.size + 8;
    let d = "";
    for (let y = 0; y < code.size; y++) {
      for (let x = 0; x < code.size; x++) {
        if (!moduleAt(code, x, y)) continue;
        let w = 1;
        while (moduleAt(code, x + w, y)) w++;
        d += `M${x + 4} ${y + 4}h${w}v1h-${w}z`;
        x += w - 1;
      }
    }
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" role="img" ` +
      `aria-label="${attr(opts.label ?? "QR code")}" shape-rendering="crispEdges">` +
      `<rect width="${n}" height="${n}" fill="${attr(opts.light ?? "#fff")}"/>` +
      `<path fill="${attr(opts.dark ?? "#000")}" d="${d}"/></svg>`
    );
  },

  /**
   * The symbol as terminal text, two modules per character row with Unicode half blocks, dark
   * modules drawn as spaces on a light quiet zone (so it scans on a dark or a light terminal
   * theme alike when `invert` matches it). Null when the text does not fit.
   */
  terminal(text: string, opts: { invert?: boolean } = {}): string | null {
    const code = encodeQr(text);
    if (!code) return null;
    // A light module is drawn; a dark one is blank. `invert` swaps them for light themes.
    const lit = (x: number, y: number) =>
      moduleAt(code, x, y) === !!opts.invert;
    const lines: string[] = [];
    for (let y = -QUIET; y < code.size + QUIET; y += 2) {
      let line = "";
      for (let x = -QUIET; x < code.size + QUIET; x++) {
        const top = lit(x, y);
        const bottom = lit(x, y + 1);
        line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
      }
      lines.push(line);
    }
    return lines.join("\n");
  },

  /** The symbol's rows as `0`/`1` strings, for a host with its own renderer. */
  rows(text: string): string[] | null {
    const code = encodeQr(text);
    return code ? qrRows(code) : null;
  },
};
