import * as React from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { t } from "../../lib/copy.js";
import { clearNudge, nudgePending } from "../lastMethod.js";
import {
  focusPageHeading,
  href,
  navigate,
  type PortalRoute,
} from "../router.js";

/**
 * "Add another way to sign in" (SIGN-IN.md §3.8 and D-40; PORTAL.md §4.10): shown on the portal
 * page that follows a first platform sign-in, until the person answers it. The Worker's
 * `nudge: true` is kept by the sign-in card (`rememberNudge`, localStorage, so a magic link in a
 * new tab still brings it) and claimed here for the account; **Not now** and **Add a way** clear
 * it for good. It never stands in an app's sign-in: the focused flows and the card pass it by.
 *
 * On Account → Sign-in methods the person is already there, so it is cleared without a card.
 * A plain region (no heading: the page's h1 comes first, and there is no h2 above it) and not an
 * alert: the page behind it is what they came for.
 */
export function AddMethodNudge({
  route,
  accountId,
}: {
  route: PortalRoute;
  accountId: string;
}): React.ReactElement | null {
  const there = route.kind === "account" && route.section === "methods";
  const [shown, setShown] = React.useState(() => nudgePending(accountId));
  React.useEffect(() => {
    if (there) clearNudge(accountId);
  }, [there, accountId]);
  const titleId = React.useId();
  if (!shown || there) return null;
  return (
    <section
      aria-labelledby={titleId}
      className="mb-6 flex flex-col gap-3 rounded-xl border border-border bg-surface-sunken p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-start gap-3">
        <ShieldCheck
          aria-hidden
          className="mt-0.5 size-5 shrink-0 text-fg-strong"
        />
        <div className="min-w-0">
          <p
            id={titleId}
            className="font-semibold text-fg-strong [overflow-wrap:anywhere]"
          >
            {t("signin.nudge.title")}
          </p>
          <p className="text-sm text-fg-muted">{t("signin.nudge.body")}</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button
          variant="outline"
          className="max-sm:min-h-11"
          onClick={() => {
            clearNudge(accountId);
            setShown(false);
            // The card is gone: focus goes to the page, not to the top of the document.
            focusPageHeading();
          }}
        >
          {t("signin.nudge.later")}
        </Button>
        <Button
          variant="neutral"
          className="max-sm:min-h-11"
          onClick={() => {
            clearNudge(accountId);
            setShown(false);
            navigate(href.account("methods"));
          }}
        >
          {t("signin.nudge.add")}
        </Button>
      </div>
    </section>
  );
}
