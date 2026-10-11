// MonogramIcon's letter (DL5), shared by both web renderers: the name's first character, upper
// case, past any bidi control a name may carry (discovery's names arrive isolated, U+2068…U+2069).

const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** The monogram's letter for `name`, or "" for a name with no visible character. */
export function monogramOf(name: string): string {
  return (
    [...name.replace(BIDI_CONTROLS, "").trim()][0]?.toLocaleUpperCase() ?? ""
  );
}
