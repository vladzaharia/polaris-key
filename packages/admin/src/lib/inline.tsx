import * as React from "react";

/**
 * A line of copy with `identifiers` in backticks drawn in mono (the style guide: identifiers in
 * code type). The server's attention lines mark them (`console/lib/attention.ts`); nothing else
 * in the line is markup.
 */
export function inlineCode(line: string): React.ReactNode[] {
  return line.split("`").map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="font-mono text-[0.9em] text-fg-strong">
        {part}
      </code>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    ),
  );
}
