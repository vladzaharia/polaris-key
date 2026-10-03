import * as React from "react";

/**
 * TEMPORARY (docs/design/ADMIN.md §7.2 chunk 2; deleted in chunk 11).
 *
 * The top bar no longer carries a page `<h1>` (it doubled every view's own title, SH-12). Until
 * each area chunk rebuilds its views on `PageHeader`, this wrapper promotes a legacy view's first
 * `<h2>` to the page heading: `aria-level="1"` (so it is the one level-1 heading assistive tech
 * sees) and `tabIndex=-1` (so route focus can land on it). Nothing about the view's markup or
 * styling changes. A view that renders its title late (after data loads) is caught by the
 * observer.
 */
export function LegacyPage({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const promote = (): void => {
      if (root.querySelector("[data-page-title]")) return;
      const h2 = root.querySelector("h2");
      if (!h2) return;
      h2.setAttribute("aria-level", "1");
      h2.setAttribute("data-page-title", "");
      if (!h2.hasAttribute("tabindex")) h2.setAttribute("tabindex", "-1");
      h2.classList.add("outline-hidden");
    };
    promote();
    const observer = new MutationObserver(promote);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} data-legacy-page="">
      {children}
    </div>
  );
}
