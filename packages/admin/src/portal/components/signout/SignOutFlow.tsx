import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { EndSessionView } from "@polaris-key/protocol/identity";
import { Button } from "../../../ui/Button.js";
import {
  AUTH_LINK_CLASS,
  AUTH_METHOD_CLASS,
  AuthCard,
  AuthNotice,
  AuthTitle,
  CardHeader,
  HeaderSkeleton,
  QuietLinks,
} from "../../../ui/auth/index.js";
import { t } from "../../../lib/copy.js";
import { HttpError, type PortalAccount } from "../../api.js";
import { portalErrorCopy } from "../../errors.js";
import { consumeQuietSignOut, signOutExpected } from "../../data.js";
import { navigation, safeRedirect } from "../../model/signInRequest.js";
import { mutate } from "../../mutations.js";
import { pq } from "../../queries.js";
import { useEndSessionRequest } from "../../requestData.js";
import { useDocumentTitle } from "../../router.js";
import { AuthLockup } from "../Lockup.js";
import { LegalNav } from "../signin/LegalNav.js";
import { AppMark } from "../signin/RequestHeader.js";
import {
  PersonRow,
  PRIMARY_CLASS,
  RequestLoading,
  Unreachable,
} from "../signin/requestParts.js";

/**
 * Polaris Locker's sign-out page (I-21.12; V5 §12.13.9; UX item `hosted:signout`): a relying party
 * sent the person here through `end-session`, and the card asks "Sign out of Polaris Locker too?".
 * **Sign out** ends this browser's Polaris Locker session and no other; **Stay signed in** ends
 * nothing. Either one returns to the relying party when the request carries a return, else the card
 * says what happened. The Worker owns every decision (the client, the return, whether there is a
 * session); this only draws it.
 *
 * - A browser with no session and a registered return has nothing to ask: it returns at once.
 * - A request that is spent or has lapsed (the browser's Back after the return, a reload, 120 s)
 *   is the **expired** step: it says whether the person is still signed in and offers to sign out.
 */
type Phase = "ask" | "done" | "stayed" | "expired";

type Step =
  | "loading"
  | "unreachable"
  | "expired"
  | "returning"
  | "ask"
  | "none"
  | "done"
  | "stayed";

/** The `?request=eo_…` of the page's address, or `null`. */
export function endSessionHandleFromUrl(
  search: string = window.location.search,
): string | null {
  const raw = new URLSearchParams(search).get("request");
  return raw && /^eo_[A-Za-z0-9_-]{22}$/.test(raw) ? raw : null;
}

export function SignOutFlow({
  handle,
  account,
}: {
  handle: string;
  /** The account this browser is signed in to, or `null`. */
  account: PortalAccount | null;
}): React.ReactElement {
  const qc = useQueryClient();
  const req = useEndSessionRequest(handle);
  const view = req.data;
  const [phase, setPhase] = React.useState<Phase>("ask");
  const [busy, setBusy] = React.useState<"confirm" | "cancel" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // A return the page tried on its own and could not make: the button is the way on.
  const [autoFailed, setAutoFailed] = React.useState(false);
  // The expired page's own Sign out: its "signed out" step has no passport (the page had none).
  const [fromExpired, setFromExpired] = React.useState(false);
  const autoStarted = React.useRef(false);

  const gone = req.error instanceof HttpError && req.error.status === 404;
  const name = view?.client?.name ?? null;
  const returnFailed = t("locker.signout.returnFailed", {
    app: name ?? view?.product.appName ?? "",
  });

  /** The session check and its CSRF token, read again (another tab may have changed either). */
  const refreshSession = (): Promise<unknown> =>
    qc.fetchQuery(pq.me()).catch(() => undefined);

  const answer = async (
    action: "confirm" | "cancel",
    auto = false,
  ): Promise<void> => {
    if (busy && !auto) return;
    setBusy(action);
    setError(null);
    // The person chose this: no "You were signed out" toast when the session check catches up.
    if (action === "confirm") signOutExpected();
    const post = () =>
      mutate(action === "confirm" ? "signoutConfirm" : "signoutCancel", handle);
    try {
      let out;
      try {
        out = await post();
      } catch (err) {
        // A stale CSRF token (another tab signed in again): take a fresh one and press once more.
        if (!(err instanceof HttpError && err.status === 403)) throw err;
        await refreshSession();
        out = await post();
      }
      const to = out.redirect === null ? null : safeRedirect(out.redirect);
      if (to !== null) {
        navigation.go(to);
        return;
      }
      setBusy(null);
      // A return the server sent that the page will not follow: say so, do not pretend there was none.
      if (out.redirect !== null) {
        consumeQuietSignOut();
        if (auto) setAutoFailed(true);
        setError(returnFailed);
        return;
      }
      setPhase(action === "confirm" ? "done" : "stayed");
    } catch (err) {
      setBusy(null);
      // Nothing ended: the next genuine sign-out still earns its toast.
      consumeQuietSignOut();
      if (
        err instanceof HttpError &&
        (err.status === 404 || err.status === 403)
      ) {
        // The request is spent or lapsed (or the session keeps changing): the expired step says what is true.
        void refreshSession();
        setPhase("expired");
        return;
      }
      if (auto) {
        // The button that is left says "Back to <App>": the line says the same thing.
        setAutoFailed(true);
        setError(returnFailed);
        return;
      }
      setError(portalErrorCopy(err, { account: true }).line);
    }
  };

  /** The expired step's own Sign out: the session only, no request to answer. */
  const signOutHere = async (): Promise<void> => {
    if (busy) return;
    setBusy("confirm");
    setError(null);
    signOutExpected();
    try {
      await mutate("signOutHere");
      // The "signed out" step moves focus to its heading and announces it.
      setFromExpired(true);
      setPhase("done");
    } catch (err) {
      consumeQuietSignOut();
      setError(portalErrorCopy(err, { account: true }).line);
    } finally {
      setBusy(null);
    }
  };

  const returning =
    !!view &&
    !view.signedIn &&
    view.returns &&
    name !== null &&
    phase === "ask" &&
    !autoFailed;
  React.useEffect(() => {
    // Nothing to end here and a registered return: go back without asking (once).
    if (!returning || autoStarted.current) return;
    autoStarted.current = true;
    void answer("cancel", true);
    // `answer` is rebuilt every render; the ref makes this run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returning]);

  const step: Step = req.isPending
    ? "loading"
    : phase === "done" || phase === "stayed"
      ? phase
      : phase === "expired" || gone
        ? "expired"
        : req.error || !view
          ? "unreachable"
          : returning
            ? "returning"
            : view.signedIn
              ? "ask"
              : "none";

  const askTitle = name
    ? t("locker.signout.title")
    : t("locker.signout.titleNoApp");
  const returningTitle = t("locker.signout.returning", { app: name ?? "" });
  const stepTitle: Record<Step, string | null> = {
    loading: null,
    unreachable: req.error
      ? portalErrorCopy(req.error, { account: true }).title
      : null,
    expired: t("locker.signout.expired.title"),
    returning: returningTitle,
    ask: askTitle,
    none: t("locker.signout.none.title"),
    done: t("locker.signout.done.title"),
    stayed: t("locker.signout.stayed.title"),
  };
  useDocumentTitle(stepTitle[step]);

  const notice = error ? <AuthNotice>{error}</AuthNotice> : null;
  const openLocker = (
    <Button asChild variant="neutral" size="xl" className={PRIMARY_CLASS}>
      <a href="/">{t("locker.signout.open")}</a>
    </Button>
  );

  let body: React.ReactNode;
  switch (step) {
    case "loading":
      body = (
        <>
          <AuthTitle className="sr-only">
            {t("locker.signout.opening")}
          </AuthTitle>
          <RequestLoading />
        </>
      );
      break;
    case "unreachable":
      body = (
        <Unreachable error={req.error} onRetry={() => void req.refetch()} />
      );
      break;
    case "expired":
      body = (
        <>
          <div className="space-y-2">
            <AuthTitle>{t("locker.signout.expired.title")}</AuthTitle>
            <p className="text-fg-muted">
              {account
                ? t("locker.signout.expired.in")
                : t("locker.signout.expired.out")}
            </p>
          </div>
          {notice}
          {account ? (
            <>
              <Button
                variant="neutral"
                size="xl"
                className={PRIMARY_CLASS}
                loading={busy === "confirm"}
                onClick={() => void signOutHere()}
              >
                {t("locker.signout.expired.signOut")}
              </Button>
              <QuietLinks>
                <a href="/" className={AUTH_LINK_CLASS}>
                  {t("locker.signout.open")}
                </a>
              </QuietLinks>
            </>
          ) : (
            openLocker
          )}
        </>
      );
      break;
    case "returning":
      body = (
        <>
          <AuthTitle>{returningTitle}</AuthTitle>
          <RequestLoading />
        </>
      );
      break;
    case "ask":
      body = (
        <>
          {account ? (
            <PersonRow
              name={account.name}
              email={account.email}
              picture={account.avatarUrl ?? null}
            />
          ) : null}
          <div className="space-y-2">
            <AuthTitle>{askTitle}</AuthTitle>
            <p className="text-fg-muted">{t("locker.signout.body")}</p>
          </div>
          {notice}
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
      break;
    case "none":
      // No session, and a return the page could not take on its own: the button goes back.
      body = (
        <>
          <AuthTitle>{t("locker.signout.none.title")}</AuthTitle>
          {notice}
          {view?.returns && name ? (
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
            openLocker
          )}
        </>
      );
      break;
    default:
      body = (
        <>
          <AuthTitle>{stepTitle[step]}</AuthTitle>
          <Button asChild variant="neutral" size="xl" className={PRIMARY_CLASS}>
            <a href="/">
              {step === "done"
                ? t("locker.signout.done.again")
                : t("locker.signout.open")}
            </a>
          </Button>
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
      header={
        req.isPending ? (
          <HeaderSkeleton />
        ) : view && !gone && step !== "expired" && !fromExpired ? (
          <SignOutHeader view={view} />
        ) : undefined
      }
      after={<LegalNav />}
      stepKey={step}
    >
      {body}
    </AuthCard>
  );
}

/**
 * Who asked, from the view alone, drawn as the sign-in card draws the app: its neutral tile (or
 * the shield for a name that failed the render-time check) with the product as a badge, "<App>
 * signed you out", the developer, and where it returns. With no client the product is named alone.
 */
function SignOutHeader({ view }: { view: EndSessionView }): React.ReactElement {
  const client = view.client;
  const shown = client ? client.name : view.product.appName;
  const verified = client ? client.nameVerified : true;
  return (
    <CardHeader
      variant="app"
      icon={
        <AppMark
          name={shown}
          slug={view.product.slug}
          verified={verified}
          iconSrc={client ? client.iconUrl : view.product.iconUrl}
          art={null}
          badge={
            client
              ? {
                  appName: view.product.appName,
                  iconUrl: view.product.iconUrl,
                }
              : null
          }
        />
      }
      name={shown}
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
      headline={
        client ? "locker.signout.header" : "locker.signout.headerProduct"
      }
    />
  );
}
