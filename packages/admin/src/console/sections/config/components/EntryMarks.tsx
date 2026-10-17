import * as React from "react";
import { TriangleAlert } from "lucide-react";
import type { ConfigEntry } from "../../../../api.js";
import { retiredNotes } from "../model/entryNotes.js";

/** The warning mark beside a key that uses a retired spelling; nothing otherwise. */
export function RetiredMark({
  entry,
}: {
  entry: ConfigEntry;
}): React.ReactElement | null {
  const notes = retiredNotes(entry);
  if (!notes.length) return null;
  return (
    <span title={notes.join(" ")}>
      <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-warning" />
      <span className="sr-only">Uses a retired spelling</span>
    </span>
  );
}
