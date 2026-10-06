/**
 * Focus an element that a navigation is about to render: the switch an action names, on a page
 * that loads its data after it mounts. Polls once a frame until the element exists, then focuses
 * it after the route's own heading focus has run (AppShell `useRouteFocus`), and scrolls it into
 * view. Gives up quietly after `timeoutMs`: the operator is on the right page either way.
 *
 * Returns a cancel function.
 */
export function focusWhenReady(id: string, timeoutMs = 4000): () => void {
  const started = Date.now();
  let frame = 0;
  let timer = 0;
  let cancelled = false;
  const tick = (): void => {
    if (cancelled) return;
    const el = document.getElementById(id);
    if (el) {
      // One more turn, so the heading focus and the dialog's focus return have both settled.
      timer = window.setTimeout(() => {
        if (cancelled) return;
        el.scrollIntoView?.({ block: "center" });
        el.focus({ preventScroll: true });
      }, 50);
      return;
    }
    if (Date.now() - started > timeoutMs) return;
    frame = window.requestAnimationFrame(tick);
  };
  frame = window.requestAnimationFrame(tick);
  return () => {
    cancelled = true;
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
}
