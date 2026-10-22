import * as React from "react";
import { ExternalLink, Mail } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import type { LibraryProduct } from "../../model/library.js";
import { SectionCard } from "./Card.js";
import { t } from "../../../lib/copy.js";
import { HELP_LINKS } from "../../helpLinks.js";
import { HelpLink } from "../HelpLink.js";

/** A long developer name or address wraps inside the button, never past the window (WCAG 1.4.10). */
const WRAPS =
  "h-auto min-h-9 max-w-full whitespace-normal py-1.5 text-start [overflow-wrap:anywhere]";

/** Help (§4.20): who handles licenses and downloads, and how to reach them (G16). */
export function HelpCard({
  product,
}: {
  product: LibraryProduct;
}): React.ReactElement {
  const { developer, supportUrl, supportEmail, website } = product.presentation;
  // Help is a head and its action (the mockup's `card-head plain`): the sentence that used to
  // sit under it said what the button already does.
  const actions = (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {!supportUrl && !supportEmail && !website ? (
        <HelpLink href={HELP_LINKS.contact}>{t("locker.help.guide")}</HelpLink>
      ) : null}
      {supportUrl ? (
        <Button asChild variant="outline" size="sm" className={WRAPS}>
          <a href={supportUrl} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden />
            {t("locker.help.contact", {
              developer: developer ?? t("license.developerFallback"),
            })}
            <span className="sr-only">{t("getIt.newTab")}</span>
          </a>
        </Button>
      ) : supportEmail ? (
        <Button asChild variant="outline" size="sm" className={WRAPS}>
          <a href={`mailto:${supportEmail}`}>
            <Mail aria-hidden />
            {t("signin.email.label")} {supportEmail}
          </a>
        </Button>
      ) : null}
      {website ? (
        <a
          href={website}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-6 max-w-full items-center gap-2 text-sm text-fg-strong [overflow-wrap:anywhere] hover:underline"
        >
          <ExternalLink aria-hidden className="size-4" />
          {new URL(website).host}
        </a>
      ) : null}
    </div>
  );
  return (
    <SectionCard
      id="help"
      title={t("locker.help.title")}
      aside={actions}
      plain
    />
  );
}
