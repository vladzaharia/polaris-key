import * as React from "react";
import type { EndSessionView } from "@polaris-key/protocol/identity";
import { Button } from "../../../ui/Button.js";
import {
  AUTH_METHOD_CLASS,
  AuthCard,
  AuthTitle,
  CardHeader,
} from "../../../ui/auth/index.js";
import { t } from "../../../lib/copy.js";
import { HttpError } from "../../api.js";
import { portalErrorCopy } from "../../errors.js";
import { signOutExpected } from "../../data.js";
import { navigation, safeRedirect } from "../../model/signInRequest.js";
import { mutate } from "../../mutations.js";
import { useEndSessionRequest } from "../../requestData.js";
import { useDocumentTitle } from "../../router.js";
import { AuthLockup } from "../Lockup.js";
import { ProductIcon } from "../ProductIcon.js";
import { LegalNav } from "../signin/LegalNav.js";
import { PRIMARY_CLASS, pendingOrMissing } from "../signin/requestParts.js";

/**
 * Polaris Locker's sign-out page (I-21.12; V5 §12.13.9; UX item `hosted:signout`): a relying party
 * sent the person here through `end-session`, and the card asks "Sign out of Polaris Locker too?".
 * **Sign out** ends this browser's Polaris Locker session and no other; **Stay signed in** ends
 * nothing. Either one returns to the relying party when the request carries a return, else the card
 * says what happened. The Worker owns every decision (the client, the return, whether there is a
 * session); this only draws it. A person with no session here sees that, and a way back.
 */
type Phase = "ask" | "done" | "stayed";

/** The `?request=eo_…` of the page's address, or `null`. */
export function endSessionHandleFromUrl(
  search: string = window.location.search,
): string | null {
  const raw = new URLSearchParams(search).get("request");
  return raw && /^eo_[A-Za-z0-9_-]{22}$/.test(raw) ? raw : null;
}

export function SignOutFlow({
  handle,
}: {
  handle: string;
}): React.ReactElement {
  const req = useEndSessionRequest(handle);
  const view = req.data;
  const [phase, setPhase] = React.useState<Phase>("ask");
  const [busy, setBusy] = React.useState<"confirm" | "cancel" | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const answer = async (action: "confirm" | "cancel"): Promise<void> => {
    if (busy) return;
    setBusy(action);
    setError(null);
    // The person chose this: no "You were signed out" toast when the session check catches up.
    if (action === "confirm") signOutExpected();
    try {
      const out = await mutate(
        action === "confirm" ? "signoutConfirm" : "signoutCancel",
        handle,
      );
      const to = out.redirect === null ? null : safeRedirect(out.redirect);
      if (to !== null) {
        navigation.go(to);
        return;
      }
      setBusy(null);
      // A return the server sent that the page will not follow: say so, do not pretend there was none.
      if (out.redirect !== null) {
        setError(t("signin.request.gone"));
        return;
      }
      setPhase(action === "confirm" ? "done" : "stayed");
    } catch (err) {
      setBusy(null);
      setError(
        err instanceof HttpError && err.status === 404
          ? t("signin.request.gone")
          : portalErrorCopy(err, { account: true }).line,
      );
    }
  };

  const name = view?.client?.name ?? null;
  const gone = req.error instanceof HttpError && req.error.status === 404;
  const titleText = req.isPending
    ? null
    : req.error
      ? gone
        ? t("signin.request.goneTitle")
        : portalErrorCopy(req.error, { account: true }).title
      : phase === "done"
        ? t("locker.signout.done.title")
        : phase === "stayed"
          ? t("locker.signout.stayed.title")
          : view?.signedIn
            ? t("locker.signout.title")
            : t("locker.signout.none.title");
  useDocumentTitle(titleText);

  let key: string;
  let body: React.ReactNode;
  const early = pendingOrMissing(req, view !== undefined);
  if (early) {
    ({ key, body } = early);
  } else if (phase === "done" || phase === "stayed") {
    key = phase;
    body = (
      <>
        <div className="space-y-2">
          <AuthTitle>
            {phase === "done"
              ? t("locker.signout.done.title")
              : t("locker.signout.stayed.title")}
          </AuthTitle>
          <p className="text-fg-muted">
            {phase === "done"
              ? t("locker.signout.done.body")
              : t("locker.signout.stayed.body")}
          </p>
        </div>
        <Button asChild variant="neutral" size="xl" className={PRIMARY_CLASS}>
          <a href="/">
            {phase === "done"
              ? t("locker.signout.done.again")
              : t("locker.signout.open")}
          </a>
        </Button>
      </>
    );
  } else if (!view.signedIn) {
    key = "none";
    body = (
      <>
        <div className="space-y-2">
          <AuthTitle>{t("locker.signout.none.title")}</AuthTitle>
          <p className="text-fg-muted">{t("locker.signout.none.body")}</p>
        </div>
        {error ? <ErrorLine text={error} /> : null}
        {view.returns && name ? (
          <Button
            variant="neutral"
            size="xl"
            className={PRIMARY_CLASS}
            loading={busy === "cancel"}
            onClick={() => void answer("cancel")}
          >
            {t("locker.signout.back", { app: name })}
          </Button>
        ) : (
          <Button asChild variant="neutral" size="xl" className={PRIMARY_CLASS}>
            <a href="/">{t("locker.signout.open")}</a>
          </Button>
        )}
      </>
    );
  } else {
    key = "ask";
    body = (
      <>
        <div className="space-y-2">
          <AuthTitle>{t("locker.signout.title")}</AuthTitle>
          <p className="text-fg-muted">
            {name
              ? t("locker.signout.body", { app: name })
              : t("locker.signout.bodyNoApp")}
          </p>
        </div>
        {error ? <ErrorLine text={error} /> : null}
        <div className="space-y-3">
          <Button
            variant="neutral"
            size="xl"
            className={PRIMARY_CLASS}
            loading={busy === "confirm"}
            onClick={() => void answer("confirm")}
          >
            {t("locker.signout.confirm")}
          </Button>
          <Button
            variant="outline"
            size="xl"
            className={AUTH_METHOD_CLASS}
            disabled={busy !== null}
            onClick={() => void answer("cancel")}
          >
            {t("locker.signout.stay")}
          </Button>
        </div>
      </>
    );
  }

  return (
    <AuthCard
      brand={
        <span className="text-fg-muted opacity-80">
          <AuthLockup />
        </span>
      }
      header={view ? <SignOutHeader view={view} /> : undefined}
      after={<LegalNav />}
      stepKey={key}
    >
      {body}
    </AuthCard>
  );
}

function ErrorLine({ text }: { text: string }): React.ReactElement {
  return (
    <p role="alert" className="text-sm/5 text-danger">
      {text}
    </p>
  );
}

/**
 * Who asked, from the view alone: the client (its own icon and the product as a badge's name) with
 * where it returns, or the product when the request named no client. A name that failed the
 * render-time check draws the neutral letter tile and no developer.
 */
function SignOutHeader({ view }: { view: EndSessionView }): React.ReactElement {
  const client = view.client;
  const shownName = client ? client.name : view.product.appName;
  const verified = client ? client.nameVerified : true;
  const iconSrc = client ? client.iconUrl : view.product.iconUrl;
  return (
    <CardHeader
      variant="context"
      icon={
        <ProductIcon
          slug={shownName.toLowerCase()}
          name={shownName}
          tint={null}
          size={56}
          src={verified ? iconSrc : null}
          neutral={!verified}
        />
      }
      name={shownName}
      developer={client && verified ? client.developerName : null}
      where={
        client && view.returns
          ? view.returnHost
            ? {
                glyph: "globe",
                text: t("locker.issuer.returnsTo", { host: view.returnHost }),
              }
            : { glyph: "app", text: t("locker.issuer.returnsDevice") }
          : null
      }
    />
  );
}
