import * as React from "react";
import { ChevronUp } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { useActivate } from "../activate.js";
import { href } from "../router.js";

/**
 * "Missing a license?" (B12, PX-35): the other ways a license reaches the account, as a slim
 * sticky strip at the end of the Library. It sticks to the bottom of the viewport while the
 * Library scrolls and settles at the page's end, so it never covers the last row of tiles. Its
 * first item is **Activate a license**, so every Library state (one product, the grid, the list)
 * reaches it.
 *
 * From `wide` (1180 px, in rem, so large text drops out of it): one line, the question and the
 * ways as compact inline links. Below it, and on phones: it sits above the phone bar, collapsed to
 * a "Missing a license?" disclosure that opens upward into a raised panel (the button comes first
 * in the DOM, `flex-col-reverse` puts the panel above it).
 *
 * The strip's height is published as `--pk-strip-h` on the document, so `scroll-padding-bottom`
 * (styles.css) keeps a focused control from sitting under it (WCAG 2.4.11) and phone toasts clear
 * it.
 */
/** Neutral ink with the coral rule (D9a); the underline tells a link from the muted text. */
const LINK =
  "inline-flex min-h-11 items-center font-medium text-fg-strong underline decoration-[var(--pk-locker-accent)] decoration-2 underline-offset-4 hover:text-fg-strong";

export function MissingLicense(): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const activate = useActivate();
  const ref = React.useRef<HTMLElement>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = (): void =>
      root.style.setProperty(
        "--pk-strip-h",
        `${Math.ceil(el.getBoundingClientRect().height)}px`,
      );
    publish();
    const ro =
      typeof ResizeObserver === "function" ? new ResizeObserver(publish) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.removeProperty("--pk-strip-h");
    };
  }, []);
  return (
    <section
      ref={ref}
      data-missing-strip
      aria-label="Missing a license?"
      className="sticky bottom-[calc(3.25rem+1px+env(safe-area-inset-bottom))] z-20 border-t border-border bg-surface-raised desk:bottom-0 short:static short:max-desk:mb-[calc(3.25rem+1px+env(safe-area-inset-bottom))]"
    >
      <div className="mx-auto flex w-full max-w-[82rem] flex-col-reverse px-4 desk:px-8 wide:flex-row wide:flex-wrap wide:items-center wide:gap-x-6">
        <p
          aria-hidden
          className="hidden shrink-0 text-sm font-medium text-fg-strong wide:block"
        >
          Missing a license?
        </p>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="missing-ways"
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-11 w-full items-center justify-between gap-2 text-sm font-medium text-fg-strong wide:hidden"
        >
          Missing a license?
          <ChevronUp
            aria-hidden
            className={cn("size-4 transition-transform", open && "rotate-180")}
          />
        </button>
        <div
          id="missing-ways"
          className={cn(
            "mb-1 rounded-lg border border-border bg-surface-overlay p-3 shadow-elevation-2 wide:contents",
            open ? "block" : "hidden wide:contents",
          )}
        >
          <p className="mb-1 text-sm font-semibold text-fg-strong wide:hidden">
            Other ways in
          </p>
          <ul className="flex flex-col gap-x-8 text-sm text-fg-muted wide:flex-row wide:flex-wrap wide:items-center">
            <li>
              Have a key?{" "}
              <button
                type="button"
                onClick={() => activate.open()}
                className={LINK}
              >
                Activate a license
              </button>
            </li>
            <li>
              Sent to another email?{" "}
              <a href={href.account("methods")} className={LINK}>
                Add it in Sign-in methods
              </a>
            </li>
            <li>
              Bought on Steam?{" "}
              <a href={href.account("methods")} className={LINK}>
                Connect Steam
              </a>
            </li>
            <li className="py-2 wide:py-0">
              App Store or Google Play? Sign in from the app
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
