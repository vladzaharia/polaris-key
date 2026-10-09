// Small inline glyphs, drawn in the colour of the text beside them.

/** The new-tab cue: an arrow out of a box (UI-KITS §1.5 rule 11: never an ellipsis). */
export function ExternalGlyph(): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="1em"
      height="1em"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5V13H3V4.5h3.5" />
    </svg>
  );
}
