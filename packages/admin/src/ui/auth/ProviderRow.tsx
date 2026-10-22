import * as React from "react";
import { cn } from "../../lib/cn.js";
import { AppleGlyph, GoogleGlyph, SteamGlyph } from "./ProviderGlyphs.js";
import { t } from "../../lib/copy.js";

/**
 * The provider row (PORTAL.md §4.1, owner decision 2026-10-04): Apple, Google and Steam as
 * logo-only, equal-width buttons in ONE row at every breakpoint, always in that order. Each is
 * named "Continue with <Provider>" (or "Connect <Provider>" when adding a method), repeated as
 * the tooltip; the row is a group labelled "Or continue with". Three split the row in thirds,
 * two in halves, and one keeps a half-row width, centred. No other providers.
 */
/** The providers the row can show (the portal's `AuthProvider`). */
export type AuthProvider = "apple" | "google" | "steam";

export const PROVIDER_ORDER: readonly AuthProvider[] = [
  "apple",
  "google",
  "steam",
];

const NAME: Record<AuthProvider, string> = {
  apple: "Apple",
  google: "Google",
  steam: "Steam",
};

export function providerLabel(
  p: AuthProvider,
  mode: "continue" | "connect",
): string {
  return t(
    mode === "connect" ? "signin.provider.connect" : "signin.provider.continue",
    { provider: NAME[p] },
  );
}

export function ProviderRow({
  providers,
  hrefFor,
  mode = "continue",
  className,
  onNavigate,
}: {
  providers: readonly AuthProvider[];
  hrefFor: (p: AuthProvider) => string;
  mode?: "continue" | "connect";
  className?: string;
  /** Runs before the browser leaves for the provider (the portal stashes a carried key). */
  onNavigate?: (p: AuthProvider) => void;
}): React.ReactElement | null {
  const list = PROVIDER_ORDER.filter((p) => providers.includes(p));
  if (list.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={
        mode === "connect"
          ? t("signin.provider.connectGroup")
          : t("signin.provider.group")
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
            onClick={() => onNavigate?.(p)}
            aria-label={label}
            title={label}
            className={cn(
              "provider-btn inline-flex h-[3.25rem] items-center justify-center rounded-md text-fg-strong",
              "hover:bg-hover",
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
