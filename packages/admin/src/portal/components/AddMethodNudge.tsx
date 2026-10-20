import * as React from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { t } from "../../lib/copy.js";
import { nudgePending } from "../lastMethod.js";
import { href, navigate, type PortalRoute } from "../router.js";

/**
 * "Add another way to sign in" (SIGN-IN.md §3.8 and D-40; PORTAL.md §4.10): shown once, on the
 * first portal page after a first platform sign-in. The Worker's `nudge: true` is kept in
 * sessionStorage by the sign-in card (`rememberNudge`); this takes it on that page and clears it, so
 * a reload, another page or **Not now** never brings it back. It never stands in an app's sign-in:
 * the focused flows and the card pass it by, and it waits for the portal.
 *
 * On Account → Sign-in methods the person is already there, so the flag is cleared without a card.
 * A plain region, not an alert: the page behind it is what they came for.
 */
export function AddMethodNudge({
  route,
}: {
  route: PortalRoute;
}): React.ReactElement | null {
  const there = route.kind === "account" && route.section === "methods";
  const [shown, setShown] = React.useState(() => nudgePending() && !there);
  // Take the flag after paint (not in the state initialiser: StrictMode runs that twice).
  React.useEffect(() => {
    nudgePending(true);
  }, []);
  const headingId = React.useId();
  if (!shown) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="mb-6 flex flex-col gap-3 rounded-xl border border-border bg-surface-sunken p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-start gap-3">
        <ShieldCheck
          aria-hidden
          className="mt-0.5 size-5 shrink-0 text-fg-strong"
        />
        <div className="min-w-0">
          <h2
            id={headingId}
            className="font-semibold text-fg-strong [overflow-wrap:anywhere]"
          >
            {t("signin.nudge.title")}
          </h2>
          <p className="text-sm text-fg-muted">{t("signin.nudge.body")}</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button
          variant="outline"
          className="max-sm:min-h-11"
          onClick={() => setShown(false)}
        >
          {t("signin.nudge.later")}
        </Button>
        <Button
          variant="neutral"
          className="max-sm:min-h-11"
          onClick={() => {
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
