import * as React from "react";
import { Globe, Smartphone } from "lucide-react";
import { cn } from "../../lib/cn.js";

/**
 * Platform and provider marks for the customer site. Drawn inline (CSP: `img-src 'self'`), mono
 * in `currentColor` except Google's G, which keeps its four colours (PORTAL.md §4.1).
 */
type GlyphProps = { className?: string };

export function AppleGlyph({ className }: GlyphProps): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={cn("fill-current", className)}
    >
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  );
}

export function GoogleGlyph({ className }: GlyphProps): React.ReactElement {
  return (
    <svg viewBox="0 0 48 48" aria-hidden className={className}>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/** Steam's mark, simplified: the disc with the piston and its two wheels. */
export function SteamGlyph({ className }: GlyphProps): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={cn("fill-current", className)}
    >
      <path
        fillRule="evenodd"
        d="M12 1a11 11 0 1 1 0 22 11 11 0 0 1 0-22zm3.5 4.25a3.75 3.75 0 0 0-3.72 4.24l-2.9 4.06a2.75 2.75 0 0 0-.38-.03c-.4 0-.78.09-1.12.24L3.6 12.4a8.6 8.6 0 0 0 .18 3.06l2.95 1.17a2.75 2.75 0 0 0 5.38-.95l4.3-3.06a3.75 3.75 0 1 0-.91-7.37zm0 1.6a2.15 2.15 0 1 1 0 4.3 2.15 2.15 0 0 1 0-4.3zM8.5 14.85a1.65 1.65 0 1 1 0 3.3 1.65 1.65 0 0 1 0-3.3z"
      />
    </svg>
  );
}

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

export const PLATFORM_NAME: Record<PlatformKey, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  ios: "iPhone and iPad",
  android: "Android",
  web: "the web",
};

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
  const label = `Runs on ${platforms.map((p) => PLATFORM_NAME[p]).join(", ")}`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex items-center gap-2.5 text-fg-muted",
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
