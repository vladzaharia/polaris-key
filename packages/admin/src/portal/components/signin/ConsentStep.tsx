import * as React from "react";
import { Cloud, ShieldCheck, UserRound } from "lucide-react";
import type { AppConsentView } from "@polaris-key/protocol/identity";
import { AUTH_LINK_CLASS, AuthNotice } from "../../../ui/auth/index.js";
import { t } from "../../../lib/copy.js";
import { Keep } from "../Keep.js";
import {
  consentLines,
  licenseParts,
  type Chosen,
} from "../../model/signInRequest.js";
import { cn } from "../../../lib/cn.js";
import { ConsentFoot, ConsentHead } from "./requestParts.js";
import { useTermsCheck } from "./TermsCheck.js";

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
  attach = false,
}: {
  /** The request adds the app's own license to the account (`purpose: attach`). */
  attach?: boolean;
  view: AppConsentView;
  app: string;
  product: string;
  device: string;
  chosen: Chosen;
  busy: "continue" | "deny" | null;
  error: string | null;
  /** Back to the licence list with the selection kept; null where no choice precedes. */
  onChange: (() => void) | null;
  /** The terms version shown, when the product's terms are unaccepted. */
  onContinue: (terms?: string) => void;
  onDeny: () => void;
  onNotYou: () => void;
}): React.ReactElement {
  const line = licenseParts(chosen, { product, app, device, attach });
  const lines = consentLines(view);
  const terms = useTermsCheck(view.terms, product);
  const go = (): void => {
    if (terms.pass()) onContinue(terms.version);
  };
  return (
    <>
      <ConsentHead person={view.person} app={app} onNotYou={onNotYou} />
      {line ? (
        <section className="space-y-2" aria-labelledby="pk-consent-license">
          <h2
            id="pk-consent-license"
            className="text-sm/5 font-medium text-fg-strong"
          >
            {t("signin.consent.license")}
          </h2>
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 rounded-lg border border-border px-4 py-3">
            <div className="min-w-[12ch] flex-[1_1_12ch] [overflow-wrap:anywhere]">
              <p className="font-medium text-fg-strong">{line.title}</p>
              {line.meta ? (
                <p className="text-sm/5 text-fg-muted">
                  <Keep>{line.meta}</Keep>
                </p>
              ) : null}
            </div>
            {onChange ? (
              <button
                type="button"
                onClick={onChange}
                className={cn(AUTH_LINK_CLASS, "shrink-0")}
              >
                {t("signin.consent.change")}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
      <section className="space-y-2" aria-labelledby="pk-consent-gets">
        <h2
          id="pk-consent-gets"
          className="text-sm/5 font-medium text-fg-strong"
        >
          {t("signin.consent.alsoGets", { app })}
        </h2>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {lines.map((text) => (
            <li
              key={text}
              className="flex items-center gap-3 px-4 py-3 text-fg"
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
        <p className="flex items-start gap-2 text-sm/5 text-fg-muted">
          <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t("signin.consent.pairwise")}
        </p>
      </section>
      <ConsentFoot
        terms={terms.check}
        error={error}
        app={app}
        busy={busy}
        onContinue={go}
        onDeny={onDeny}
      />
    </>
  );
}
