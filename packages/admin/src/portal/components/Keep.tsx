import * as React from "react";

/**
 * The phrases of customer copy that must not break across lines (LF3): a seat position ("device
 * 2 of 3") and the idle-devices note ("1 more device", "signed in,", "not using a seat"). The words
 * stay as the catalog wrote them; each phrase gets a `nowrap` span, so the text, the translation
 * and a screen reader are untouched and a narrow column breaks between phrases, not inside one.
 */
const PHRASES =
  /(device \d+ of \d+|\d+ more devices?|signed in,|not using a seat)/;

export function Keep({ children }: { children: string }): React.ReactElement {
  // `split` with one capture group alternates plain text and matched phrases.
  const parts = children.split(PHRASES);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="whitespace-nowrap bigtext:whitespace-normal">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}
