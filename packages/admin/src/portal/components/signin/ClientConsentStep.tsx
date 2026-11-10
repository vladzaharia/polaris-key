import * as React from "react";
import { Lock, ShieldCheck, UserRound } from "lucide-react";
import type { AppConsentView } from "@polaris-key/protocol/identity";
import { Button } from "../../../ui/Button.js";
import {
  AUTH_METHOD_CLASS,
  AuthNotice,
  AuthTitle,
} from "../../../ui/auth/index.js";
import { t } from "../../../lib/copy.js";
import { clientLines } from "../../model/signInRequest.js";
import { ConsentActions, ConsentHead, PRIMARY_CLASS } from "./requestParts.js";

/**
 * ConsentStep for a registered client (Sign in with <Product>; V5 §12.13.3, §12.13.6). "Continue to
 * <Client> as <first name>?", then what the client gets, one line each: the profile claims (a switch
 * on each optional one, a "Required" tag and no switch on the rest), the features line and the
 * stay-signed-in line, which have no switch and are granted by Continue. No licence line, no Cloud
 * Sync. **Continue** and **Don't allow** are the same width and height; declining a required claim
 * is Don't allow. The grant is the Worker's: this only posts the claims switched on.
 */
export function ClientConsentStep({
  view,
  app,
  product,
  busy,
  error,
  onContinue,
  onDeny,
  onNotYou,
}: {
  view: AppConsentView;
  app: string;
  product: string;
  busy: "continue" | "deny" | null;
  error: string | null;
  /** The claims switched on, to post as `consent.claims`. */
  onContinue: (claims: string[]) => void;
  onDeny: () => void;
  onNotYou: () => void;
}): React.ReactElement {
  const lines = clientLines(view, app, product);
  const [off, setOff] = React.useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string): void =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const claims = lines
    .filter((l) => l.claim && !off.has(l.id))
    .map((l) => l.id);
  return (
    <>
      <ConsentHead person={view.person} app={app} onNotYou={onNotYou} />
      {lines.length > 0 ? (
        <section className="space-y-2" aria-labelledby="pk-client-gets">
          <h2
            id="pk-client-gets"
            className="text-sm/5 font-medium text-fg-strong"
          >
            {t("locker.issuer.gets", { app })}
          </h2>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {lines.map((line) => (
              <li
                key={line.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-fg"
              >
                <UserRound
                  aria-hidden
                  className="size-5 shrink-0 text-fg-muted"
                />
                <span className="min-w-[9ch] flex-[1_1_9ch] [overflow-wrap:anywhere]">
                  {line.text}
                </span>
                {line.claim && line.required ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-sm/5 text-fg-muted">
                    <Lock aria-hidden className="size-4" />
                    {t("locker.issuer.required")}
                  </span>
                ) : line.claim ? (
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={line.text}
                    checked={!off.has(line.id)}
                    onChange={() => toggle(line.id)}
                    className="size-5 shrink-0 accent-[var(--pk-accent,currentColor)]"
                  />
                ) : null}
              </li>
            ))}
          </ul>
          <p className="flex items-start gap-2 text-sm/5 text-fg-muted">
            <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
            {t("locker.issuer.sameForAll", { product })}
          </p>
        </section>
      ) : null}
      {error ? <AuthNotice>{error}</AuthNotice> : null}
      <ConsentActions
        app={app}
        busy={busy}
        onContinue={() => onContinue(claims)}
        onDeny={onDeny}
      />
    </>
  );
}

/**
 * The step before consent when the client asked for a fresh sign-in (`prompt=login`, or a sign-in
 * older than `max_age`). The current Locker session is ended, so the card's sign-in comes back.
 */
export function ReauthStep({
  app,
  busy,
  onSignInAgain,
  onDeny,
}: {
  app: string;
  busy: boolean;
  onSignInAgain: () => void;
  onDeny: () => void;
}): React.ReactElement {
  return (
    <>
      <div className="space-y-2">
        <AuthTitle>{t("locker.issuer.reauth.title")}</AuthTitle>
        <p className="text-fg-muted">
          {t("locker.issuer.reauth.body", { app })}
        </p>
      </div>
      <div className="space-y-3">
        <Button
          variant="neutral"
          size="xl"
          className={PRIMARY_CLASS}
          loading={busy}
          onClick={onSignInAgain}
        >
          {t("locker.issuer.reauth.button")}
        </Button>
        <Button
          variant="outline"
          size="xl"
          className={AUTH_METHOD_CLASS}
          onClick={onDeny}
        >
          {t("signin.consent.deny")}
        </Button>
      </div>
    </>
  );
}
