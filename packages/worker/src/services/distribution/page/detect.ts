/**
 * Server-side platform detection for the public download page (P2b-06).
 *
 * The page runs NO script (it is served sandboxed on the bytes host; `page/index.ts`), so the
 * detection notes/A3 §3.2 describes in the browser happens here, from what the browser sends
 * without being asked:
 *
 *   1. User-Agent Client Hints. `Sec-CH-UA-Platform` and `Sec-CH-UA-Mobile` are low-entropy hints
 *      every Chromium browser sends on a secure request by default; no `Accept-CH` round trip.
 *   2. The User-Agent string, as the fallback (Safari and Firefox send no hints).
 *
 * The one case a server cannot settle is iPadOS, whose Safari reports itself as a Mac
 * ("Macintosh", the server-side twin of `navigator.platform === "MacIntel"`). The browser-side
 * fix is `maxTouchPoints > 1`; the script-free equivalent is a CSS media query on the pointer
 * (`(hover: none) and (pointer: coarse)`), which the renderer uses to swap the Mac primary action
 * for the iOS one on a touch-only device. `touchAmbiguous` marks exactly that case.
 *
 * Architecture is a hint only: the high-entropy `Sec-CH-UA-Arch` is never requested, and Apple
 * silicon cannot be told from Intel at all (notes/A3 §3.2), so a universal build is preferred
 * wherever one exists.
 */

/** The platforms the page groups its actions under, in display order. */
export const PAGE_PLATFORMS = [
  "ios",
  "android",
  "macos",
  "windows",
  "linux",
] as const;
export type PagePlatform = (typeof PAGE_PLATFORMS)[number];

export const PLATFORM_LABELS: Readonly<Record<PagePlatform, string>> = {
  ios: "iPhone and iPad",
  android: "Android",
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

export interface DetectedPlatform {
  platform: PagePlatform | null;
  arch: "arm64" | "x86_64" | null;
  /** The browser said "Mac" in a way an iPad also does: the page lets CSS decide. */
  touchAmbiguous: boolean;
}

/** `"macOS"` → `macOS`: a structured-header string, unquoted; anything else → `null`. */
function hintString(raw: string | null): string | null {
  if (raw === null) return null;
  const m = /^\s*"([^"\\]{0,64})"\s*$/.exec(raw);
  return m ? m[1]! : null;
}

const HINT_PLATFORMS: Readonly<Record<string, PagePlatform>> = {
  android: "android",
  ios: "ios",
  macos: "macos",
  windows: "windows",
  linux: "linux",
};

function archOf(ua: string): DetectedPlatform["arch"] {
  if (/\b(aarch64|arm64)\b/i.test(ua)) return "arm64";
  if (/\b(x86_64|x64|win64|wow64|amd64)\b/i.test(ua)) return "x86_64";
  return null;
}

/** Detect the visitor's platform from request headers. Never throws. */
export function detectPlatform(headers: Headers): DetectedPlatform {
  const ua = (headers.get("user-agent") ?? "").slice(0, 512);
  const arch = archOf(ua);
  const hint = hintString(headers.get("sec-ch-ua-platform"));
  const hinted = hint ? HINT_PLATFORMS[hint.toLowerCase()] : undefined;
  if (hinted) return { platform: hinted, arch, touchAmbiguous: false };

  if (/\b(iPhone|iPod|iPad)\b/.test(ua))
    return { platform: "ios", arch: null, touchAmbiguous: false };
  if (/\bAndroid\b/.test(ua))
    return { platform: "android", arch: null, touchAmbiguous: false };
  if (/\bWindows NT\b/.test(ua))
    return { platform: "windows", arch, touchAmbiguous: false };
  if (/\b(Macintosh|Mac OS X)\b/.test(ua))
    return { platform: "macos", arch: null, touchAmbiguous: true };
  // ChromeOS is neither: it can run Android apps and Linux binaries, so nothing is assumed.
  if (/\bCrOS\b/.test(ua))
    return { platform: null, arch: null, touchAmbiguous: false };
  if (/\bLinux\b/.test(ua))
    return { platform: "linux", arch, touchAmbiguous: false };
  return { platform: null, arch: null, touchAmbiguous: false };
}
