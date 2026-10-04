/**
 * Polaris Key license keys (PORTAL.md §4.17): `pkey_<product-slug>_<22 characters of
 * base64url>`, case-sensitive, never grouped or re-cased.
 */

/**
 * The masked display: the prefix, the slug, an ellipsis and the last 4 (`pkey_tidewater_…KQ2w`).
 * Without the last 4 (today's Worker keeps none, G7) it ends at the ellipsis.
 */
export function maskKey(slug: string, last4?: string | null): string {
  return `pkey_${slug}_…${last4 ?? ""}`;
}
