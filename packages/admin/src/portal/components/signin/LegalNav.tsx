import * as React from "react";
import { AUTH_LINK_CLASS } from "../../../ui/auth/index.js";
import { cn } from "../../../lib/cn.js";
import { t } from "../../../lib/copy.js";
import { HELP_LINKS } from "../../helpLinks.js";

/**
 * Help · Privacy, under the sign-in card: every step of an app's request carries it. Footer type
 * (14/20 at 400, --pk-text-muted) in the card's link style; the middot is muted and `aria-hidden`
 * with 8 px each side. `help` points Help at one article (the code step: "didn't get a code?").
 */
export function LegalNav({ help }: { help?: string } = {}): React.ReactElement {
  const link = cn(AUTH_LINK_CLASS, "text-fg-muted align-middle");
  return (
    <nav
      aria-label={t("locker.shell.help")}
      // Inline, not flex: the dot stays in the links' text run (the tier-separator rule), and the
      // links wrap on a narrow window.
      className="text-center text-sm/5 text-fg-muted"
    >
      <a href={help ?? HELP_LINKS.help} className={link}>
        {t("locker.shell.helpLink")}
      </a>
      <span aria-hidden className="px-2 align-middle text-fg-muted">
        ·
      </span>
      <a href={HELP_LINKS.privacy} className={link}>
        {t("locker.shell.privacy")}
      </a>
    </nav>
  );
}
