import * as React from "react";
import { StationaryStar } from "../../ui/EmptyState.js";

/** A centred screen with the stationary star: boot, network errors and other no-context states. */
export function StarScreen({
  title,
  children,
  busy,
}: {
  title: string;
  children?: React.ReactNode;
  busy?: boolean;
}): React.ReactElement {
  return (
    <main
      aria-busy={busy || undefined}
      className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-surface-page px-4 text-center text-fg"
    >
      <StationaryStar />
      <h1 className="text-xl font-semibold text-fg-strong">{title}</h1>
      {children}
    </main>
  );
}
