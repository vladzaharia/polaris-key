import * as React from "react";
import { cn } from "../lib/cn.js";
import { markPartPath } from "./markPath.js";
import { useChangedSinceMount } from "./motion/changed.js";

/**
 * Gold means signed, and nothing else (BRAND.md §4.5, §7.3; components.md §6.5).
 *
 * `SignedGlyph` is the Pinned K's terminal-bit rhombus, taken from the brand geometry, filled with
 * the `signed` indicator token. It is decorative: the label beside it says "Signed". Gold is never
 * text: badge labels stay `text-fg`, and the chip variant puts `signed-on` text on a gold fill.
 */
const BIT = markPartPath("gold", {
  kind: "key",
  size: 48,
  theme: "mono",
  signed: true,
});

export function SignedGlyph({
  size = 10,
  className,
}: {
  size?: 10 | 12;
  className?: string;
}): React.ReactElement {
  return (
    <svg
      aria-hidden
      focusable="false"
      width={size}
      height={size}
      viewBox={BIT.viewBox}
      className={cn("shrink-0 fill-signed", className)}
    >
      <path d={BIT.d} />
    </svg>
  );
}

export interface SignedBadgeProps {
  /** The signing key id, e.g. `rk-2026-09`. */
  kid?: string;
  /** What signed it, for the accessible text: "release key", "content key". */
  by?: string;
  /** `badge`: gold glyph + text. `chip`: gold fill with `signed-on` text. */
  variant?: "badge" | "chip";
  /** A verified signature ("Signature verified") rather than a signed record. */
  verified?: boolean;
  /** Truncate a long kid (a table column); the full kid stays in the tooltip. */
  truncateKid?: boolean;
  className?: string;
}

export function SignedBadge({
  kid,
  by,
  variant = "badge",
  verified = false,
  truncateKid = false,
  className,
}: SignedBadgeProps): React.ReactElement {
  const word = verified ? "Signature verified" : "Signed";
  // A record that becomes verified pops its new word; colours ease (S-23 §6.1 "status"; MO-09).
  const popped = useChangedSinceMount(word);
  return (
    <span
      className={cn(
        "pk-pill inline-flex items-center gap-1.5 whitespace-nowrap text-xs",
        variant === "chip"
          ? "rounded-full border border-signed-border bg-signed px-2 py-0.5 font-bold text-signed-on"
          : "text-fg",
        className,
      )}
    >
      {variant === "chip" ? (
        <SignedGlyph size={10} className="fill-signed-on" />
      ) : (
        <SignedGlyph size={12} />
      )}
      <span className={cn(truncateKid && "inline-flex min-w-0 items-baseline")}>
        <span key={word} className={cn(popped && "pk-pop-in inline-block")}>
          {word}
        </span>
        {kid ? (
          <>
            {"\u00a0·\u00a0"}
            <span
              className={cn(
                "font-mono",
                truncateKid &&
                  "inline-block max-w-[8rem] truncate align-bottom",
              )}
              title={truncateKid ? kid : undefined}
            >
              {kid}
            </span>
          </>
        ) : null}
        {by ? <span className="sr-only"> by {by}</span> : null}
      </span>
    </span>
  );
}
