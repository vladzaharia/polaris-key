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

/**
 * After Try again on a failed load, focus goes to the nearest heading, so a keyboard or screen-reader
 * user is not thrown to the top of the document and hears where they are: the card's `h2` when the
 * panel sits in a card (`section[aria-labelledby]`), else the page `h1`. The heading may be inside the
 * panel itself (it goes when the retry starts); then this waits for the real one, skipping a
 * placeholder inside an `aria-busy` skeleton, for about ten seconds at most. A panel that survives
 * the retry (it failed again, same element) keeps focus on its button.
 */
export function focusAfterRetry(panel: Element | null): void {
  const id = panel
    ?.closest("section[aria-labelledby]")
    ?.getAttribute("aria-labelledby");
  const target = (): HTMLElement | null =>
    id
      ? document.getElementById(id)
      : document.querySelector<HTMLElement>("main h1");
  let frames = 0;
  const attempt = (): void => {
    if (frames++ > 600) return;
    const el = target();
    const waiting =
      !el ||
      !el.isConnected ||
      el.closest('[aria-busy="true"]') != null ||
      (panel?.isConnected === true && panel.contains(el));
    if (waiting) {
      requestAnimationFrame(attempt);
      return;
    }
    if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
    el.focus({ preventScroll: true });
  };
  requestAnimationFrame(attempt);
}

const STEP_UP_KEY = "pk.stepUpReturn";

/**
 * A step-up through a provider leaves the page and comes back to a fresh load, which starts at the
 * top of the document. The sign-in link notes the leaving; {@link consumeStepUpReturn} reads it
 * once on the way back, and the shell puts focus on the page heading.
 */
export function markStepUpLeave(): void {
  try {
    window.sessionStorage.setItem(STEP_UP_KEY, "1");
  } catch {
    /* private mode: focus starts at the top, as before */
  }
}

export function consumeStepUpReturn(): boolean {
  try {
    const was = window.sessionStorage.getItem(STEP_UP_KEY) === "1";
    window.sessionStorage.removeItem(STEP_UP_KEY);
    return was;
  } catch {
    return false;
  }
}
