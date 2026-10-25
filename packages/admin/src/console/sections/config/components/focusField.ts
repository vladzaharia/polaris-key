/**
 * Where focus goes after something that unmounts the control that had it (a settled conflict, the
 * review drawer closing on "Fix it"). Queried from the DOM, because the target lives in another
 * component; run after the update has rendered.
 */

const FOCUSABLE = "input, textarea, select, button, [role='combobox']";

/** The entry card's heading, made focusable on demand. */
function entryHeading(): HTMLElement | null {
  const h = document.querySelector<HTMLElement>("#entry-card h2");
  if (h && h.tabIndex < 0 && !h.hasAttribute("tabindex"))
    h.setAttribute("tabindex", "-1");
  return h;
}

/** The control of the form field called `name`, when it is drawn. */
export function fieldControl(name: string): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(
    `[data-field^="f-${name.replace(/[^\w-]/g, "-")}-"]`,
  );
  if (!el) return null;
  return el.matches(FOCUSABLE) ? el : el.querySelector<HTMLElement>(FOCUSABLE);
}

/**
 * After a conflict is settled: the next conflict's Keep mine; else the field just settled; else
 * the entry's heading. Never `<body>`.
 */
export function focusAfterSettle(field: string, delay = 0): void {
  window.setTimeout(() => {
    const target =
      document.querySelector<HTMLElement>("[data-conflict-keep]") ??
      fieldControl(field) ??
      entryHeading();
    target?.focus();
  }, delay);
}

/** After "Fix it": the first invalid field of the opened entry, else its heading. */
export function focusInvalid(field: string | undefined): void {
  // The drawer hands focus back to its trigger as it closes; this runs after that.
  window.setTimeout(() => {
    const target =
      (field ? fieldControl(field) : null) ??
      document.querySelector<HTMLElement>(
        "#entry-card [aria-invalid='true']",
      ) ??
      entryHeading();
    target?.focus();
  }, 120);
}
