/**
 * The "Polaris Key does this" list for Publish from CI, kept short: all done is one line, and on a
 * phone the done rows fold away so the person's steps come first (SETUP §4.3).
 */

import * as React from "react";
import { Check } from "lucide-react";
import { AutoList, type AutoItem } from "../../../../../ui/wizard/index.js";

const PHONE = "(max-width: 639px)";

function usePhone(): boolean {
  return React.useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia?.(PHONE);
      mq?.addEventListener("change", cb);
      return () => mq?.removeEventListener("change", cb);
    },
    () => window.matchMedia?.(PHONE).matches ?? false,
    () => false,
  );
}

const Summary = ({ children }: { children: React.ReactNode }) => (
  <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-sm text-fg-strong">
    {children}
  </summary>
);

export function CiChecks({
  items,
}: {
  items: readonly AutoItem[];
}): React.ReactElement | null {
  const phone = usePhone();
  const done = items.filter((i) => i.state === "done");
  const rest = items.filter((i) => i.state !== "done");
  if (items.length === 0) return null;
  if (rest.length === 0)
    return (
      <details className="rounded-lg border border-border">
        <Summary>
          <Check aria-hidden className="size-4 text-success" />
          Polaris Key did {items.length}{" "}
          {items.length === 1 ? "thing" : "things"}
        </Summary>
        <div className="px-3 pb-3">
          <AutoList items={items} quietDone title="Polaris Key did" />
        </div>
      </details>
    );
  const title = `Polaris Key does this · ${done.length} of ${items.length} done`;
  if (phone && done.length > 0)
    return (
      <div className="space-y-2">
        <AutoList items={rest} quietDone title={title} />
        <details className="rounded-lg border border-border">
          <Summary>Show the {done.length} done</Summary>
          <div className="px-3 pb-3">
            <AutoList items={done} quietDone title="Done" />
          </div>
        </details>
      </div>
    );
  return <AutoList items={items} quietDone title={title} />;
}
