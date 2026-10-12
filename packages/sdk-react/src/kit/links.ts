// The kit's one link validator (UI-KITS DL14): a server or integrator link is shown,
// copied, or opened only when it is HTTPS (with loopback HTTP for local sign-in).

/** The link as a normalized string when it is safe to show and open, else `null`. */
export function safeLink(value: string | null | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url.href;
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  return url.protocol === "http:" && loopback ? url.href : null;
}

/** Open a validated link in a new tab. Only ever called from a click. */
export function openLink(href: string): void {
  if (typeof window !== "undefined" && typeof window.open === "function")
    window.open(href, "_blank", "noopener,noreferrer");
}
