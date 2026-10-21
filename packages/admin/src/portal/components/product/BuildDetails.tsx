import { t } from "../../../lib/copy.js";
import * as React from "react";
import { cn } from "../../../lib/cn.js";
import { truncateMiddle } from "../../../lib/format.js";
import { CopyButton } from "../../../ui/CopyButton.js";
import { Popover } from "../../../ui/Popover.js";
import { GET_IT_COPY as C } from "../../copy/getIt.js";

/**
 * The chosen build's facts under its action (PORTAL.md §4.25 item 4, portal.download): the
 * channel with its day, the SHA-256 and the one-line install hint, in one raised card. Each row
 * is left out when the view doesn't give it, and the card with them: never an empty frame.
 *
 * The SHA-256 is middle-truncated at rest, with the whole value in a popover (never only a
 * `title`) and a **Copy** button (36 px, labelled) named for the value.
 */
export function BuildDetails({
  channel,
  sha256,
  hint,
}: {
  /** "Stable · Sep 22, 2026" (the day only for the channel's newest release). */
  channel: string | null;
  sha256: string | null;
  /** What opens the file, from its format (`installHint`). */
  hint: string | null;
}): React.ReactElement | null {
  const facts = Boolean(channel) || Boolean(sha256);
  if (!facts && !hint) return null;
  return (
    <div className="rounded-xl border border-border bg-surface-raised">
      {facts ? (
        <dl className="divide-y divide-border">
          {channel ? (
            <Fact term={C["getIt.flow.channel"]}>{channel}</Fact>
          ) : null}
          {sha256 ? (
            <Fact term={C["getIt.flow.sha256"]}>
              <Sha256 value={sha256} />
            </Fact>
          ) : null}
        </dl>
      ) : null}
      {hint ? (
        <p
          className={cn(
            "px-4 py-3 text-sm text-fg-muted [overflow-wrap:anywhere]",
            facts && "border-t border-border",
          )}
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** One fact: the term beside its value from 640 px, above it under that (a 320 px screen). */
function Fact({
  term,
  children,
}: {
  term: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="grid gap-x-4 gap-y-1 px-4 py-3 sm:min-h-14 sm:grid-cols-[6rem_minmax(0,1fr)] sm:items-center">
      <dt className="text-sm text-fg-muted">{term}</dt>
      <dd className="min-w-0 text-md text-fg-strong [overflow-wrap:anywhere]">
        {children}
      </dd>
    </div>
  );
}

function Sha256({ value }: { value: string }): React.ReactElement {
  const short = truncateMiddle(value, 6, 4);
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Popover
        label={C["getIt.flow.fullSha256"]}
        trigger={
          <button
            type="button"
            aria-label={t("locker.files.showFull", {
              label: C["getIt.flow.sha256"],
              detail: short,
            })}
            className="-ml-2 inline-flex h-9 pointer-coarse:h-11 items-center rounded-md px-2 font-mono text-code text-fg hover:text-fg-strong"
          >
            <span aria-hidden>{short}</span>
          </button>
        }
      >
        <p className="mb-1 text-xs text-fg-muted">
          {C["getIt.flow.fullSha256"]}
        </p>
        <code className="break-all font-mono text-code text-fg-strong">
          {value}
        </code>
      </Popover>
      <CopyButton
        value={value}
        label={C["getIt.flow.copySha256"]}
        showLabel
        size="md"
      />
    </span>
  );
}
