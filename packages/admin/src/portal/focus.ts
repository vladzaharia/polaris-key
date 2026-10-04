/**
 * "After adding a product, focus lands on the new product's `h1`" (PORTAL.md §9.4). The
 * Activate dialog asks before it navigates; the product page takes the request once its
 * heading exists.
 */
let pending: string | null = null;

export function requestHeadingFocus(slug: string): void {
  pending = slug;
}

export function consumeHeadingFocus(slug: string): boolean {
  if (pending !== slug) return false;
  pending = null;
  return true;
}
