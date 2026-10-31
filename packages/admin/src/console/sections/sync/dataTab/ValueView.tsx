/** Users → Data → Values: how a stored value reads, clamped in a row and whole in the drawer. */

import * as React from "react";
import type { SyncJsonValue } from "../../../../api.js";

/** A value as one line of JSON, for a row (the row clamps it to two lines). */
export function oneLine(v: SyncJsonValue | null): string {
  return JSON.stringify(v) ?? "null";
}

/** A value as JSON text with a 2-space indent. */
export function prettyJson(v: SyncJsonValue | null): string {
  return JSON.stringify(v, null, 2) ?? "null";
}

const STRING = /"(?:[^"\\]|\\.)*"/g;

/**
 * Pretty JSON where each string token sits in a `<bdi>`: a right-to-left name or value keeps its
 * own order and does not reorder the braces and colons around it. The block itself is `ltr`.
 */
export function PrettyJson({
  value,
  className,
}: {
  value: SyncJsonValue | null;
  className?: string;
}): React.ReactElement {
  const text = prettyJson(value);
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(STRING)) {
    const i = m.index ?? 0;
    if (i > at) parts.push(text.slice(at, i));
    parts.push(<bdi key={i}>{m[0]}</bdi>);
    at = i + m[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return (
    <pre
      dir="ltr"
      className={
        className ??
        "whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-xs text-fg"
      }
    >
      {parts}
    </pre>
  );
}

/** A value in a row: two lines at most, never one character wide. */
export function ClampedValue({
  value,
  sealed,
  fileOnly,
}: {
  value: SyncJsonValue | null;
  sealed: boolean;
  fileOnly?: boolean;
}): React.ReactElement {
  if (sealed) return <span className="text-fg-muted">Sealed</span>;
  if (value === null && fileOnly)
    return <span className="text-fg-muted">File only</span>;
  return (
    <code
      dir="ltr"
      className="line-clamp-2 min-w-0 font-mono text-xs [overflow-wrap:anywhere]"
    >
      {oneLine(value)}
    </code>
  );
}
