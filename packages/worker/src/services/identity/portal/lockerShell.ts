/**
 * The portal shell as Polaris Locker (LK-06, plans/LK-00.md D1): the same built `index.html`,
 * with `data-brand="locker"` on `<html>` (the SPA reads it as the mode), the Locker title and the
 * Locker web identity (`/assets/branding/locker/`, from `@polaris-key/brand/web/locker`).
 *
 * Only attributes and link targets change: the inline theme script is untouched, so its hash in
 * `core/adminCsp.ts` still holds (`adminCspParity`). Each swap is exact; a shell that no longer
 * contains the text it expects is returned as it was rather than half-branded.
 */

const KEY = "/assets/branding/key/";
const LOCKER = "/assets/branding/locker/";

export function lockerShell(html: string): string {
  if (!html.includes('<html lang="en">') || !html.includes(KEY)) return html;
  return html
    .replace('<html lang="en">', '<html lang="en" data-brand="locker">')
    .replace("<title>Polaris Key</title>", "<title>Polaris Locker</title>")
    .replaceAll(`${KEY}app-icon-dark-180.png`, `${LOCKER}apple-touch-icon.png`)
    .replaceAll(KEY, LOCKER);
}
