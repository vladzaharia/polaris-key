import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/cn.js";
import {
  TONE_ICON,
  statusOf,
  type StatusDomain,
  type Tone,
} from "../lib/status.js";
import { SignedGlyph } from "./SignedBadge.js";

/**
 * A status as icon plus text, never colour alone (components.md §6.4). Either vocabulary-driven
 * (`domain` + `state`, from `lib/status.ts`) or explicit (`tone` + children). Status colours never
 * change by section; only `accent` follows the section (a rollout in progress, a pinned cell).
 */
export const TONE_CLASSES: Record<Tone, string> = {
  success: "border-success-border bg-success-subtle text-success",
  warning: "border-warning-border bg-warning-subtle text-warning",
  danger: "border-danger-border bg-danger-subtle text-danger",
  info: "border-info-border bg-info-subtle text-info",
  neutral: "border-border bg-surface-sunken text-fg-muted",
  accent: "border-accent bg-accent-subtle text-accent-fg",
  // Gold is an indicator, never text: the glyph is gold, the label stays default text.
  signed: "border-signed-border bg-signed-subtle text-fg",
  // The compat matrix's "current": a ring and the word, no fill.
  outline: "border-fg-muted bg-transparent text-fg",
};

export interface StatusPillProps {
  domain?: StatusDomain;
  state?: string;
  tone?: Tone;
  /** Overrides the vocabulary's icon. `null` renders a dot instead. */
  icon?: LucideIcon | null;
  /** Overrides the vocabulary's label ("Rolling out 25 %"). */
  children?: React.ReactNode;
  size?: "sm" | "md";
  className?: string;
}

export function StatusPill({
  domain,
  state,
  tone,
  icon,
  children,
  size = "md",
  className,
}: StatusPillProps): React.ReactElement {
  const entry =
    domain && state !== undefined ? statusOf(domain, state) : undefined;
  const t: Tone = tone ?? entry?.tone ?? "neutral";
  const Icon = icon === null ? null : (icon ?? entry?.icon ?? TONE_ICON[t]);
  const label = children ?? entry?.label ?? "";
  return (
    <span
      data-tone={t}
      className={cn(
        "inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full border font-normal",
        size === "sm" ? "h-5 px-1.5 text-xs" : "h-6 px-2 text-xs",
        TONE_CLASSES[t],
        className,
      )}
    >
      {t === "signed" ? (
        <SignedGlyph size={10} />
      ) : Icon ? (
        <Icon aria-hidden className={size === "sm" ? "size-3" : "size-3.5"} />
      ) : (
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
      )}
      <span className="truncate">{label}</span>
    </span>
  );
}
