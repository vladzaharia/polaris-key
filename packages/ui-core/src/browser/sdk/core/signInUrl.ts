// The one check a Cloud Sync sign-in URL passes before it reaches app code.

/**
 * A sign-in URL fit to hand to the app: https on the Worker's `origin`, else null. A path is
 * resolved against `origin`; control characters and whitespace are refused before parsing (the URL
 * parser would strip some of them and read the rest as another host).
 */
export function safeSignInUrl(
  url: string | null,
  origin: string | undefined,
): string | null {
  if (url === null || origin === undefined || /[\x00-\x20\x7f-\x9f]/.test(url))
    return null;
  try {
    const u = new URL(url, origin);
    return u.protocol === "https:" && u.origin === origin ? u.href : null;
  } catch {
    return null;
  }
}
