// The kit's one link validator (UI-KITS DL14): a link the server or the integrator supplied is
// shown, copied or opened only when it is https (the loopback redirect of a local sign-in is the
// one http exception). Anything else hides the control that would use it; the kit never makes a
// link up.

/** The link as a normalised string when it is safe to show and open, else `null`. */
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

/** A link as a person reads it: the host and path, without the scheme or a trailing slash. */
export function linkText(href: string): string {
  const url = new URL(href);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.host}${path}`;
}

/** Open a validated link in a new tab. Only ever called from a click. */
export function openLink(href: string): void {
  if (typeof window !== "undefined" && typeof window.open === "function")
    window.open(href, "_blank", "noopener,noreferrer");
}
