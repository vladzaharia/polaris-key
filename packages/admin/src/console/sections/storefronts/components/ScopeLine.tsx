import * as React from "react";

/** Under Storefronts (A-20.7): which platforms the listed stores are for. */
export function ScopeLine({
  platforms,
}: {
  platforms: string[];
}): React.ReactElement | null {
  if (platforms.length === 0) return null;
  return (
    <p className="text-sm text-fg-muted">Stores for {platforms.join(", ")}</p>
  );
}
