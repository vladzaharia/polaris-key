import * as React from "react";
import { t } from "../../lib/copy.js";
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

export function MissingLicense({
  hideActivate = false,
}: {
  /** The Library's key tile is on screen (2-7 products): it is the way to Activate there. */
  hideActivate?: boolean;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const activate = useActivate();
  const ref = React.useRef<HTMLElement>(null);
  const toggleRef = React.useRef<HTMLButtonElement>(null);
  // The open disclosure closes on Escape (focus back on the toggle) and on a press outside it.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
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
      aria-label={t("locker.missing.title")}
      className="sticky bottom-[calc(3.25rem+1px+env(safe-area-inset-bottom))] z-20 border-t border-border bg-surface-raised desk:bottom-0 short:static short:max-desk:mb-[calc(3.25rem+1px+env(safe-area-inset-bottom))] tight:max-desk:static tight:max-desk:mb-[calc(3.25rem+1px+env(safe-area-inset-bottom))]"
    >
      <div className="mx-auto flex w-full max-w-[82rem] flex-col-reverse px-4 desk:px-8 wide:flex-row wide:flex-wrap wide:items-center wide:gap-x-6">
        <p
          aria-hidden
          className="hidden shrink-0 text-sm font-medium text-fg-strong wide:block"
        >
          {t("locker.missing.title")}
        </p>
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={open}
          aria-controls="missing-ways"
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-11 w-full items-center justify-between gap-2 text-sm font-medium text-fg-strong wide:hidden"
        >
          {t("locker.missing.title")}
          <ChevronUp
            aria-hidden
            className={cn("size-4 transition-transform", open && "rotate-180")}
          />
        </button>
        <div
          id="missing-ways"
          className={cn(
            "mb-1 w-full max-w-md rounded-lg border border-border bg-surface-overlay p-3 shadow-elevation-2 wide:contents",
            open ? "block" : "hidden wide:contents",
          )}
        >
          <p className="mb-1 text-sm font-semibold text-fg-strong wide:hidden">
            {t("locker.missing.otherWays")}
          </p>
          <ul className="flex flex-col gap-x-6 text-sm text-fg-muted wide:flex-row wide:flex-wrap wide:items-center wide:py-1">
            {hideActivate ? null : (
              <li>
                <button
                  type="button"
                  onClick={() => activate.open()}
                  className={LINK}
                >
                  {t("common.activateLicense")}
                </button>
              </li>
            )}
            <li>
              {t("locker.missing.anotherEmail")}{" "}
              <a href={href.account("methods")} className={LINK}>
                {t("locker.missing.addInMethods")}
              </a>
            </li>
            {/* Text, not a link: Steam purchases come back through the app's Restore purchase;
                Sign-in methods attaches nothing (B-075). */}
            <li className="py-2 wide:py-0">{t("locker.missing.steamTitle")}</li>
            <li className="py-2 wide:py-0">{t("locker.missing.inStore")}</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
