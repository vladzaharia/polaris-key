import { t } from "../lib/copy.js";
import * as React from "react";
import { Globe, Smartphone } from "lucide-react";
import { cn } from "../lib/cn.js";
import { platformInSentence } from "../lib/vocab/platforms.js";
import {
  AppleGlyph,
  GoogleGlyph,
  SteamGlyph,
  type GlyphProps,
} from "./auth/ProviderGlyphs.js";

/** Platform and provider marks for the customer site (the provider marks live in `ui/auth`). */
export { AppleGlyph, GoogleGlyph, SteamGlyph };

export function WindowsGlyph({ className }: GlyphProps): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={cn("fill-current", className)}
    >
      <path d="M3 5.1 10.4 4v7.3H3zM11.4 3.9 21 2.5v8.8h-9.6zM3 12.6h7.4V20L3 18.9zM11.4 12.6H21v8.9l-9.6-1.4z" />
    </svg>
  );
}

/** Linux: a simple penguin. */
export function LinuxGlyph({ className }: GlyphProps): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={cn("fill-current", className)}
    >
      <path
        fillRule="evenodd"
        d="M12 2c2.3 0 3.6 1.9 3.6 4.4 0 1.3.5 2.3 1.4 3.6 1.2 1.7 2.4 3.6 2.4 6 0 1.3-.4 2.4-1.1 3.2.6.3 1 .8 1 1.4 0 .9-1.2 1.4-3 1.4-1.2 0-2-.3-2.4-.8a8.4 8.4 0 0 1-3.8 0c-.4.5-1.2.8-2.4.8-1.8 0-3-.5-3-1.4 0-.6.4-1.1 1-1.4A4.8 4.8 0 0 1 4.6 16c0-2.4 1.2-4.3 2.4-6 .9-1.3 1.4-2.3 1.4-3.6C8.4 3.9 9.7 2 12 2zm0 7.3c-1.9 0-3.4 2.6-3.4 5.8 0 2.6 1.5 4.2 3.4 4.2s3.4-1.6 3.4-4.2c0-3.2-1.5-5.8-3.4-5.8zM10.6 5a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6zm2.8 0a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6z"
      />
    </svg>
  );
}

export function AndroidGlyph({ className }: GlyphProps): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={cn("fill-current", className)}
    >
      <path d="M6.2 7.6 4.7 5a.5.5 0 0 1 .9-.5l1.5 2.6A9.6 9.6 0 0 1 12 6c1.8 0 3.5.4 4.9 1.1l1.5-2.6a.5.5 0 0 1 .9.5l-1.5 2.6A8.3 8.3 0 0 1 21.5 14h-19a8.3 8.3 0 0 1 3.7-6.4zM8 10.2a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm8 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM2.5 15.5h19V19a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 19z" />
    </svg>
  );
}

export type PlatformKey =
  | "macos"
  | "windows"
  | "linux"
  | "ios"
  | "android"
  | "web";

export const PLATFORM_ORDER: readonly PlatformKey[] = [
  "windows",
  "macos",
  "linux",
  "ios",
  "android",
  "web",
];

export function PlatformGlyph({
  platform,
  className = "size-4",
}: {
  platform: PlatformKey;
  className?: string;
}): React.ReactElement {
  switch (platform) {
    case "macos":
      return <AppleGlyph className={className} />;
    case "windows":
      return <WindowsGlyph className={className} />;
    case "linux":
      return <LinuxGlyph className={className} />;
    case "ios":
      return <Smartphone aria-hidden className={className} />;
    case "android":
      return <AndroidGlyph className={className} />;
    case "web":
      return <Globe aria-hidden className={className} />;
  }
}

/** A row of platform glyphs, named once for assistive tech (PORTAL.md §9.2). */
export function PlatformGlyphs({
  platforms,
  className,
}: {
  platforms: readonly PlatformKey[];
  className?: string;
}): React.ReactElement | null {
  if (platforms.length === 0) return null;
  const label = t("locker.platform.runsOn", {
    detail: platforms.map((p) => platformInSentence(p)).join(", "),
  });
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex items-center gap-2 text-fg-muted",
        className,
      )}
    >
      {platforms.map((p) => (
        <PlatformGlyph key={p} platform={p} />
      ))}
    </span>
  );
}

/**
 * A sign-in method's mark where one is drawn (Apple, Google, Steam), else null: the source badge
 * on an avatar, the name chips and the picture tiles (Account → Profile, PX-22).
 */
export function ProviderGlyph({
  provider,
  className,
}: {
  provider: string | null | undefined;
  className?: string;
}): React.ReactElement | null {
  if (provider === "apple") return <AppleGlyph className={className} />;
  if (provider === "google") return <GoogleGlyph className={className} />;
  if (provider === "steam") return <SteamGlyph className={className} />;
  return null;
}

/**
 * An avatar's source badge: the provider's mark, or null when none is drawn, so no empty badge
 * is ever shown (Game Center, a removed method, an upload, Initials).
 */
export function providerBadge(
  provider: string | null | undefined,
): React.ReactElement | null {
  return provider === "apple" ||
    provider === "google" ||
    provider === "steam" ? (
    <ProviderGlyph provider={provider} />
  ) : null;
}
