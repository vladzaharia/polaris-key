import * as React from "react";
import {
  BadgeCheck,
  Ban,
  ExternalLink,
  GitPullRequest,
  Plug,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/cn.js";

/**
 * How an adapter performs one operation (A-18j; notes/S-15 §6.1): ONE badge for storefront tiles
 * and package-feed pages alike, rendered from the adapter's declaration (`core/adapters/contract.ts`
 * `Support`) and never from a store or ecosystem name. A new adapter therefore needs no console
 * code: its declaration is all this reads.
 *
 * It is a label, not a status: a small outlined tag with a glyph and a word (pills mean attention
 * in this console). An `unsupported` operation says so in plain words, and its reason is visible
 * text in a strip (`CapabilityStrip`), never only a tooltip.
 */
export type CapabilityMode =
  | "api"
  | "ci"
  | "pr"
  | "deep-link"
  | "first-party"
  | "unsupported";

/** The part of a `Support` declaration the badge reads. */
export interface CapabilitySupport {
  mode: CapabilityMode | (string & {});
  reason?: string;
  tool?: string;
  repo?: string;
}

const MODE: Record<CapabilityMode, { label: string; icon: LucideIcon }> = {
  api: { label: "API", icon: Plug },
  ci: { label: "CI", icon: Workflow },
  pr: { label: "PR", icon: GitPullRequest },
  "deep-link": { label: "Link", icon: ExternalLink },
  // PS-01, PS-06: the built-in storefront runs it on Polaris Key's own tables (notes/S-21 §6.1).
  "first-party": { label: "Built in", icon: BadgeCheck },
  unsupported: { label: "Not offered", icon: Ban },
};

/** What a mode means, in one sentence (the badge's accessible description). */
export const CAPABILITY_MEANING: Record<CapabilityMode, string> = {
  api: "Polaris Key performs it through the store's API.",
  ci: "The release workflow performs it in CI.",
  pr: "CI opens a pull request for it.",
  "deep-link":
    "Done by hand in the store's own console, from a link with the values to copy.",
  "first-party":
    "Built into Polaris Key: it runs on Polaris Key's own records, with nothing to connect.",
  unsupported: "The store or protocol has no such operation.",
};

const known = (m: string): m is CapabilityMode => m in MODE;

export function CapabilityBadge({
  support,
  className,
}: {
  support: CapabilitySupport;
  className?: string;
}): React.ReactElement {
  const mode: CapabilityMode = known(support.mode)
    ? support.mode
    : "unsupported";
  const { label, icon: Icon } = MODE[mode];
  return (
    <span
      data-capability={mode}
      title={CAPABILITY_MEANING[mode]}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-sm border px-1.5 text-xs font-medium",
        mode === "unsupported"
          ? "border-border text-fg-muted"
          : "border-border-strong text-fg",
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      {label}
    </span>
  );
}

export interface CapabilityItem {
  /** The operation's id (`writeListingText`, `yank`). */
  op: string;
  /** Its name, sentence case ("Listing text"). */
  label: string;
  support: CapabilitySupport;
}

/**
 * A capability strip: one row per operation, its name on the left and its badge on the right,
 * equal-height rows. An `unsupported` operation's reason is shown under its name.
 */
export function CapabilityStrip({
  items,
  label,
  className,
}: {
  items: CapabilityItem[];
  /** The strip's accessible name ("Google Play capabilities"). */
  label: string;
  className?: string;
}): React.ReactElement {
  return (
    <ul aria-label={label} className={cn("divide-y divide-border", className)}>
      {items.map((item) => (
        <li
          key={item.op}
          className="flex min-h-10 items-center justify-between gap-3 py-1.5"
        >
          <span className="min-w-0">
            <span className="block text-sm text-fg">{item.label}</span>
            {item.support.mode === "unsupported" && item.support.reason ? (
              <span className="block text-xs text-fg-muted">
                {item.support.reason}
              </span>
            ) : null}
          </span>
          <CapabilityBadge support={item.support} />
        </li>
      ))}
    </ul>
  );
}

/** A compact count of how an adapter covers its operations ("4 API · 3 links"). */
export function capabilitySummary(items: CapabilityItem[]): string {
  const n = (m: CapabilityMode) =>
    items.filter((i) => i.support.mode === m).length;
  const parts: string[] = [];
  if (n("api")) parts.push(`${n("api")} API`);
  if (n("ci")) parts.push(`${n("ci")} CI`);
  if (n("pr")) parts.push(`${n("pr")} PR`);
  if (n("deep-link"))
    parts.push(`${n("deep-link")} link${n("deep-link") === 1 ? "" : "s"}`);
  if (n("first-party")) parts.push(`${n("first-party")} built in`);
  return parts.join(" · ");
}
