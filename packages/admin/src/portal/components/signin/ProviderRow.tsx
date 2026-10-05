import * as React from "react";
import { cn } from "../../../lib/cn.js";
import type { PortalProvider } from "../../api.js";
import { AppleGlyph, GoogleGlyph, SteamGlyph } from "../Glyphs.js";

/**
 * The provider row (PORTAL.md §4.1, owner decision 2026-10-04): Apple, Google and Steam as
 * logo-only, equal-width buttons in ONE row at every breakpoint, always in that order. Each is
 * named "Continue with <Provider>" (or "Connect <Provider>" when adding a method), repeated as
 * the tooltip; the row is a group labelled "Or continue with". Three split the row in thirds,
 * two in halves, and one keeps a half-row width, centred. No other providers.
 */
export const PROVIDER_ORDER: readonly PortalProvider[] = [
  "apple",
  "google",
  "steam",
];

const NAME: Record<PortalProvider, string> = {
  apple: "Apple",
  google: "Google",
  steam: "Steam",
};

export function providerLabel(
  p: PortalProvider,
  mode: "continue" | "connect",
): string {
  return mode === "connect" ? `Connect ${NAME[p]}` : `Continue with ${NAME[p]}`;
}

export function ProviderRow({
  providers,
  hrefFor,
  mode = "continue",
  className,
}: {
  providers: readonly PortalProvider[];
  hrefFor: (p: PortalProvider) => string;
  mode?: "continue" | "connect";
  className?: string;
}): React.ReactElement | null {
  const list = PROVIDER_ORDER.filter((p) => providers.includes(p));
  if (list.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={
        mode === "connect" ? "Or connect another account" : "Or continue with"
      }
      data-count={list.length}
      className={cn(
        "grid gap-3",
        list.length === 3 ? "grid-cols-3" : "grid-cols-2",
        className,
      )}
    >
      {list.map((p) => {
        const label = providerLabel(p, mode);
        return (
          <a
            key={p}
            href={hrefFor(p)}
            aria-label={label}
            title={label}
            className={cn(
              "inline-flex h-[3.25rem] items-center justify-center rounded-md border border-border bg-hover text-fg-strong",
              "hover:border-border-strong",
              list.length === 1 && "col-span-2 mx-auto w-[calc(50%-0.375rem)]",
            )}
          >
            {p === "apple" ? (
              <AppleGlyph className="size-6" />
            ) : p === "google" ? (
              <GoogleGlyph className="size-6" />
            ) : (
              <SteamGlyph className="size-6" />
            )}
          </a>
        );
      })}
    </div>
  );
}
