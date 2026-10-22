import * as React from "react";
import { t } from "../../../lib/copy.js";
import { HELP_LINKS } from "../../helpLinks.js";

/** Help · Privacy, under the sign-in card: every step of an app's request carries it. */
export function LegalNav(): React.ReactElement {
  return (
    <nav
      aria-label={t("locker.shell.help")}
      // Inline, not flex: the dot stays in the links' text run (the tier-separator rule), and the
      // links wrap on a narrow window.
      className="text-center"
    >
      <a
        href={HELP_LINKS.help}
        className="inline-flex min-h-11 items-center align-middle underline underline-offset-4 hover:text-fg-strong"
      >
        {t("locker.shell.helpLink")}
      </a>
      <span aria-hidden className="px-1 align-middle">
        ·
      </span>
      <a
        href={HELP_LINKS.privacy}
        className="inline-flex min-h-11 items-center align-middle underline underline-offset-4 hover:text-fg-strong"
      >
        {t("locker.shell.privacy")}
      </a>
    </nav>
  );
}
