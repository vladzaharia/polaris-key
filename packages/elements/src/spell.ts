/** A code as a screen reader should say it: one character at a time. "WDJB-MJHT" reads as a word
 *  otherwise. The visible text stays exactly as served. */
export function spellOut(code: string): string {
  return [...code].join(" ");
}
