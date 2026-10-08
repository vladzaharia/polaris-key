/**
 * "After adding a product, focus lands on the new product's `h1`" (PORTAL.md §9.4). The
 * Activate dialog asks before it navigates; the product page takes the request once its
 * heading exists. The router (MO-05) focuses every other page's heading itself, and leaves a
 * pending request to the product page.
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

/** The product whose page will take focus itself, if any (read without consuming it). */
export function pendingHeadingFocus(): string | null {
  return pending;
}

/**
 * After a jump from a page's section nav (product or account page), focus that section's heading
 * (`section-<id>-h`, `SectionCard`'s `h2`), so the next Tab starts in the section rather than back
 * in the nav (PS-05 review M4). Without scrolling: the jump's own scroll (smooth, or instant under
 * reduced motion) is the one that runs. The heading draws no ring (styles.css).
 */
export function focusSectionHeading(section: string): void {
  const h = document.getElementById(`section-${section}-h`);
  if (!h) return;
  if (!h.hasAttribute("tabindex")) h.tabIndex = -1;
  h.focus({ preventScroll: true });
}
