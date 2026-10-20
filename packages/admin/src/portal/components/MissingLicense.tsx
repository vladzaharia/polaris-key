import * as React from "react";
import { ChevronUp } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { href } from "../router.js";

/**
 * "Missing a license?" (B12, PX-35): the other ways a license reaches the account, as a slim
 * sticky strip at the end of the Library. It sticks to the bottom of the viewport while the
 * Library scrolls and settles at the page's end, so it never covers the last row of tiles.
 *
 * Tablets and up: one line, the question and the three ways as compact inline links. Phones: it
 * sits above the phone bar and collapses to a "Missing a license?" button that opens the ways
 * upward. A license sent to another email joins through Account → Sign-in methods; a Steam
 * purchase through a sign-in method; the App Store and Google Play through the product's own
 * sign-in.
 */
/** Neutral ink with the coral rule (D9a); the underline tells a link from the muted text. */
const LINK =
  "inline-flex min-h-11 items-center font-medium text-fg-strong underline decoration-[var(--pk-locker-accent)] decoration-2 underline-offset-4 hover:text-fg-strong";

export function MissingLicense(): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  return (
    <section
      aria-label="Missing a license?"
      className="sticky bottom-[calc(3.25rem+1px+env(safe-area-inset-bottom))] z-20 border-t border-border bg-surface-raised desk:bottom-0 short:static"
    >
      <div className="mx-auto flex w-full max-w-[82rem] px-4 desk:px-8 flex-col xxl:max-w-[104rem] desk:flex-row desk:flex-wrap desk:items-center desk:gap-x-6">
        <p
          aria-hidden
          className="hidden shrink-0 text-sm font-medium text-fg-strong desk:block"
        >
          Missing a license?
        </p>
        <ul
          id="missing-ways"
          className={cn(
            "flex-col gap-x-8 pt-1 text-sm text-fg-muted desk:flex desk:flex-row desk:flex-wrap desk:items-center desk:pt-0",
            // On phones the ways open upward: the list comes before the button.
            open ? "flex" : "hidden",
          )}
        >
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
          <li className="py-2 desk:py-0">
            App Store or Google Play? Sign in in the app
          </li>
        </ul>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="missing-ways"
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-11 w-full items-center justify-between gap-2 text-sm font-medium text-fg-strong desk:hidden"
        >
          Missing a license?
          <ChevronUp
            aria-hidden
            className={cn("size-4 transition-transform", open && "rotate-180")}
          />
        </button>
      </div>
    </section>
  );
}
