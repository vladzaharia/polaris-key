import * as React from "react";
import { cn } from "../../lib/cn.js";
import { t } from "../../lib/copy.js";
import { AUTH_LINK_CLASS } from "./parts.js";

/**
 * Help · Privacy, under the sign-in card, for both brands: footer type (14/20 at 400,
 * `--pk-text-muted`) in the card's link style; the middot is muted and `aria-hidden` with 8 px each
 * side. The host names the two destinations (Locker: customer Help; the console: public pages).
 */
export function FooterNav({
  help,
  privacy,
}: {
  help: string;
  privacy: string;
}): React.ReactElement {
  // No min-width: padding reaches the 44 px floor below the desk breakpoint on both links, so the dot sits evenly.
  const link = cn(
    AUTH_LINK_CLASS,
    "text-fg-muted align-middle min-w-0! max-[47.5624rem]:px-2",
  );
  return (
    <nav
      aria-label={t("locker.shell.help")}
      // Inline, not flex: the dot stays in the links' text run, and the links wrap on a narrow window.
      className="text-center text-sm/5 text-fg-muted"
    >
      <a href={help} className={link}>
        {t("locker.shell.helpLink")}
      </a>
      <span aria-hidden className="px-2 align-middle text-fg-muted">
        ·
      </span>
      <a href={privacy} className={link}>
        {t("locker.shell.privacy")}
      </a>
    </nav>
  );
}
