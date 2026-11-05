import * as React from "react";
import { FooterNav } from "../../../ui/auth/FooterNav.js";
import { HELP_LINKS } from "../../helpLinks.js";

/**
 * Help · Privacy, under the Locker sign-in card: every step of an app's request carries it.
 * `help` points Help at one article (the code step: "didn't get a code?").
 */
export function LegalNav({ help }: { help?: string } = {}): React.ReactElement {
  return (
    <FooterNav help={help ?? HELP_LINKS.help} privacy={HELP_LINKS.privacy} />
  );
}
