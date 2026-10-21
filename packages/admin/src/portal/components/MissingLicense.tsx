import * as React from "react";
import { t, tParts } from "../../lib/copy.js";
import { Mail, Store } from "lucide-react";
import { href } from "../router.js";
import { SteamGlyph } from "./Glyphs.js";

/**
 * "Missing a license?" (B12): the other ways a license reaches the account, as a quiet strip
 * under the library. A license sent to another email joins through Account → Sign-in methods;
 * a store purchase (Steam through a sign-in method, the App Store and Google Play through the
 * product's own sign-in).
 */
/** Colour alone does not tell a link from the muted text around it (WCAG 1.4.1). */
const LINK = "font-medium text-accent-fg underline underline-offset-2";

/** A sentence that links to Account → Sign-in methods where it names it. */
function methodsLine(
  key: "locker.missing.emailBody" | "locker.missing.steamBody",
): React.ReactNode {
  return tParts(key, ["place"]).map((part, i) =>
    typeof part === "string" ? (
      part
    ) : (
      <a key={i} href={href.account("methods")} className={LINK}>
        {t("signin.join.methodsLink")}
      </a>
    ),
  );
}

export function MissingLicense(): React.ReactElement {
  return (
    <section aria-labelledby="missing-h" className="space-y-4">
      <h2 id="missing-h" className="text-lg font-semibold text-fg-strong">
        {t("locker.missing.title")}
      </h2>
      <ul className="grid gap-4 desk:grid-cols-3">
        <li className="flex gap-3">
          <Glyph>
            <Mail aria-hidden className="size-4" />
          </Glyph>
          <p className="text-sm text-fg-muted">
            <strong className="block font-medium text-fg-strong">
              {t("locker.missing.emailTitle")}
            </strong>
            {methodsLine("locker.missing.emailBody")}
          </p>
        </li>
        <li className="flex gap-3">
          <Glyph>
            <SteamGlyph className="size-4" />
          </Glyph>
          <p className="text-sm text-fg-muted">
            <strong className="block font-medium text-fg-strong">
              {t("locker.missing.steamTitle")}
            </strong>
            {methodsLine("locker.missing.steamBody")}
          </p>
        </li>
        <li className="flex gap-3">
          <Glyph>
            <Store aria-hidden className="size-4" />
          </Glyph>
          <p className="text-sm text-fg-muted">
            <strong className="block font-medium text-fg-strong">
              {t("locker.missing.storeTitle")}
            </strong>
            {t("locker.missing.storeBody")}
          </p>
        </li>
      </ul>
    </section>
  );
}

function Glyph({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span
      aria-hidden
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-fg-muted"
    >
      {children}
    </span>
  );
}
