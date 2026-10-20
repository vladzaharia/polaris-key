import * as React from "react";
import { Cloud, ShieldCheck, UserRound } from "lucide-react";
import type { AppConsentView } from "@polaris-key/protocol/identity";
import { Button } from "../../../ui/Button.js";
import { AuthNotice, AuthTitle } from "../../../ui/auth/index.js";
import { t } from "../../../lib/copy.js";
import {
  consentLines,
  firstName,
  licenseParts,
  type Chosen,
} from "../../model/signInRequest.js";
import { PersonRow, PRIMARY_CLASS } from "./requestParts.js";

/**
 * ConsentStep (SIGN-IN.md §3.8, PX-14a): "Continue to <App> as <first name>?". The chosen licence
 * with **Change**, what the app will also get (each fact once, no toggles: PX-14b adds them),
 * then **Continue to <App>** and **Don't allow** at equal width and height, after the scopes they
 * decide. Continue applies the choice, any Replace and the grant together.
 */
export function ConsentStep({
  view,
  app,
  product,
  device,
  chosen,
  busy,
  error,
  onChange,
  onContinue,
  onDeny,
  onNotYou,
}: {
  view: AppConsentView;
  app: string;
  product: string;
  device: string;
  chosen: Chosen;
  busy: "continue" | "deny" | null;
  error: string | null;
  /** Back to the licence list with the selection kept; null where no choice precedes. */
  onChange: (() => void) | null;
  onContinue: () => void;
  onDeny: () => void;
  onNotYou: () => void;
}): React.ReactElement {
  const line = licenseParts(chosen, { product, app, device });
  const lines = consentLines(view);
  return (
    <>
      <PersonRow
        name={view.person.displayName}
        email={view.person.email}
        picture={view.person.avatarUrl}
        onNotYou={onNotYou}
      />
      <AuthTitle>
        {t("signin.consent.title", {
          app,
          name: firstName(view.person.displayName, view.person.email),
        })}
      </AuthTitle>
      {line ? (
        <section className="space-y-2" aria-labelledby="pk-consent-license">
          <h2
            id="pk-consent-license"
            className="text-sm font-medium text-fg-muted"
          >
            {t("signin.consent.license")}
          </h2>
          <div className="flex items-start justify-between gap-3 rounded-md border border-border-strong px-3 py-3">
            <div className="min-w-0 [overflow-wrap:anywhere]">
              <p className="font-semibold text-fg-strong">{line.title}</p>
              {line.meta ? (
                <p className="text-sm text-fg-muted">{line.meta}</p>
              ) : null}
            </div>
            {onChange ? (
              <button
                type="button"
                onClick={onChange}
                className="inline-flex min-h-11 shrink-0 items-center rounded-sm px-1 text-sm underline decoration-2 underline-offset-4 hover:text-fg-strong"
              >
                {t("signin.consent.change")}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
      <section className="space-y-2" aria-labelledby="pk-consent-gets">
        <h2 id="pk-consent-gets" className="text-sm font-medium text-fg-muted">
          {t("signin.consent.alsoGets", { app })}
        </h2>
        <ul className="divide-y divide-border rounded-md border border-border-strong">
          {lines.map((text) => (
            <li
              key={text}
              className="flex items-center gap-3 px-3 py-3 text-fg-strong"
            >
              {text === t("signin.consent.cloudSync") ? (
                <Cloud aria-hidden className="size-5 shrink-0 text-fg-muted" />
              ) : (
                <UserRound
                  aria-hidden
                  className="size-5 shrink-0 text-fg-muted"
                />
              )}
              {text}
            </li>
          ))}
        </ul>
        <p className="flex items-start gap-2 text-sm text-fg-muted">
          <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t("signin.consent.pairwise")}
        </p>
      </section>
      {error ? <AuthNotice>{error}</AuthNotice> : null}
      <div className="space-y-3">
        <Button
          variant="neutral"
          size="lg"
          className={PRIMARY_CLASS}
          loading={busy === "continue"}
          busyFocusable
          onClick={onContinue}
        >
          {t("signin.consent.continue", { app })}
        </Button>
        <Button
          variant="outline"
          size="lg"
          className={PRIMARY_CLASS}
          loading={busy === "deny"}
          busyFocusable
          onClick={onDeny}
        >
          {t("signin.consent.deny")}
        </Button>
      </div>
    </>
  );
}
