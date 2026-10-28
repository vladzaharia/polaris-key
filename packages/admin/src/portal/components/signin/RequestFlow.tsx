import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { LicenseChoice } from "@polaris-key/protocol/identity";
import { Button } from "../../../ui/Button.js";
import { Spinner } from "../../../ui/Spinner.js";
import {
  AuthCard,
  AuthTitle,
  QuietLink,
  QuietLinks,
} from "../../../ui/auth/index.js";
import { t } from "../../../lib/copy.js";
import {
  HttpError,
  type PortalAccount,
  type SignInContinueRequest,
} from "../../api.js";
import { portalErrorCopy } from "../../errors.js";
import { useDocumentTitle } from "../../router.js";
import {
  firstName,
  navigation,
  safeRedirect,
  waitText,
  thisDeviceName,
  thisDeviceTitle,
  type Chosen,
  type DeviceRowModel,
} from "../../model/signInRequest.js";
import {
  useSignInConsent,
  useSignInLicenses,
  useSignInRequest,
} from "../../requestData.js";
import { AuthLockup } from "../Lockup.js";
import { LegalNav } from "./LegalNav.js";
import { ConsentStep } from "./ConsentStep.js";
import { LicenseChoiceStep } from "./LicenseChoiceStep.js";
import { ReplaceDeviceStep } from "./ReplaceDeviceStep.js";
import { ReplacedDone } from "./ReplacedDone.js";
import { ReturnStep } from "./ReturnStep.js";
import { RequestFooter, RequestHeader } from "./RequestHeader.js";
import { PersonRow, PRIMARY_CLASS } from "./requestParts.js";
import { qk } from "../../queries.js";
import { mutate } from "../../mutations.js";

/**
 * The signed-in half of an app sign-in (SIGN-IN.md §3.6 to §3.8, §4.16; PX-14a): one card at
 * `/signin?request=rq_…` whose header and footer never change while the body goes licence choice,
 * Replace a device, consent, and the return. The Worker owns every decision (the rows, their
 * order, the preselection, whether Replace is allowed); this only draws it and posts the choice
 * with Continue. Cancel and **Don't allow** return `access_denied` to the app.
 */
type Step =
  | { kind: "choice" }
  | { kind: "replace"; row: LicenseChoice }
  | { kind: "consent" }
  | { kind: "done"; replaced: string; redirect: string }
  | { kind: "return"; redirect: string; yours: boolean; tier: string | null };

export function RequestFlow({
  account,
  handle,
  focusOnArrival = false,
}: {
  account: PortalAccount;
  handle: string;
  /** This tab just signed in (the code step is gone): the first step takes the focus. */
  focusOnArrival?: boolean;
}): React.ReactElement {
  const qc = useQueryClient();
  const req = useSignInRequest(handle);
  const view = req.data;
  const cardChooses =
    view !== undefined &&
    view.client.services.license &&
    view.licenseChoice !== "app";
  const licenses = useSignInLicenses(handle, cardChooses);
  const consent = useSignInConsent(handle, view !== undefined);
  const [step, setStep] = React.useState<Step | null>(null);
  const [chosen, setChosen] = React.useState<Chosen | null>(null);
  const [direction, setDirection] = React.useState<"forward" | "back">(
    "forward",
  );
  const [busy, setBusy] = React.useState<"continue" | "deny" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const go = (next: Step, dir: "forward" | "back" = "forward"): void => {
    setError(null);
    setDirection(dir);
    setStep(next);
  };

  const lic = licenses.data;
  // What the data says before the person has done anything.
  const initial: Step | null = !view
    ? null
    : !cardChooses
      ? { kind: "consent" }
      : !lic
        ? null
        : lic.state === "autoIssue"
          ? { kind: "consent" }
          : { kind: "choice" };
  const current = step ?? initial;
  const effectiveChosen: Chosen =
    chosen ??
    (!view || !view.client.services.license
      ? { kind: "none" }
      : !cardChooses
        ? { kind: "app" }
        : lic?.state === "autoIssue"
          ? { kind: "new", tierName: lic.create?.tierName ?? "" }
          : { kind: "none" });

  // Escape backs out of the steps that have a step to go back to.
  React.useEffect(() => {
    if (current?.kind !== "replace" && !(current?.kind === "consent" && chosen))
      return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !e.defaultPrevented)
        go({ kind: "choice" }, "back");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const notYou = async (): Promise<void> => {
    try {
      await mutate("signOutHere");
    } catch {
      // The session was not ended (the table only runs after a confirmed write), so the families
      // stay; the session check says what is true.
      await qc.invalidateQueries({ queryKey: qk.me() });
    }
  };

  const leave = (redirect: string): void => {
    const to = safeRedirect(redirect);
    if (to) navigation.go(to);
    else setError(t("signin.request.gone"));
  };

  const deny = async (): Promise<void> => {
    if (busy) return;
    setBusy("deny");
    setError(null);
    try {
      leave((await mutate("signinCancel", handle)).redirect);
    } catch (err) {
      setBusy(null);
      setError(refusalText(err));
    }
  };

  const proceed = async (): Promise<void> => {
    if (busy) return;
    setBusy("continue");
    setError(null);
    const body: SignInContinueRequest = {};
    if (chosen?.kind === "license")
      body.choice = {
        kind: "license",
        licenseId: chosen.row.id,
        ...(chosen.replace ? { replaceDeviceId: chosen.replace.id } : {}),
      };
    else if (chosen?.kind === "create") body.choice = { kind: "create" };
    try {
      const out = await mutate("signinContinue", handle, body);
      if (chosen?.kind === "license" && chosen.replace) {
        setBusy(null);
        go({
          kind: "done",
          replaced: chosen.replace.label,
          redirect: out.redirect,
        });
        return;
      }
      // A native app gets the ReturnStep (§3.10); a web app's Continue is the redirect itself.
      if (view?.client.kind === "native") {
        setBusy(null);
        go({
          kind: "return",
          redirect: out.redirect,
          yours:
            chosen?.kind === "create" ||
            (chosen === null && effectiveChosen.kind === "new"),
          tier: lic?.create?.tierName ?? null,
        });
        return;
      }
      leave(out.redirect);
    } catch (err) {
      setBusy(null);
      if (
        err instanceof HttpError &&
        (err.code === "license_choice_required" ||
          err.code === "device_limit" ||
          err.status === 404)
      ) {
        // The seat or the device changed since the list loaded: the list says what is true now.
        setNotice(
          err.status === 404 && chosen?.kind === "license" && chosen.replace
            ? t("signin.replace.gone")
            : t("signin.choice.raced"),
        );
        setChosen(null);
        await qc.invalidateQueries({
          queryKey: qk.signinLicenses(handle),
        });
        go({ kind: "choice" }, "back");
        return;
      }
      setError(refusalText(err));
    }
  };

  // Once the sign-in is done (the Return and replaced steps) the pane no longer says the app
  // "wants you to sign in": it keeps the product-context form, as the key on-ramp does.
  const header = view ? (
    <RequestHeader
      view={view}
      onRamp={current?.kind === "return" || current?.kind === "done"}
    />
  ) : undefined;
  const titleText =
    current?.kind === "done"
      ? t("signin.choice.replacedTitle")
      : current?.kind === "replace"
        ? t("signin.replace.heading")
        : current?.kind === "consent"
          ? t("signin.consent.title", {
              app: view?.client.appName ?? "",
              name: consent.data
                ? firstName(
                    consent.data.person.displayName,
                    consent.data.person.email,
                  )
                : "",
            })
          : lic?.state === "none"
            ? t("signin.none.title", { product: view?.client.appName ?? "" })
            : req.error
              ? req.error instanceof HttpError && req.error.status === 404
                ? t("signin.request.goneTitle")
                : portalErrorCopy(req.error, { account: true }).title
              : licenses.error
                ? portalErrorCopy(licenses.error, { account: true }).title
                : t("signin.choice.title");
  useDocumentTitle(titleText);
  const footer = view ? <RequestFooter view={view} /> : undefined;
  const brand = (
    <span className="text-fg-muted opacity-80">
      <AuthLockup />
    </span>
  );

  let body: React.ReactNode;
  let key: string;
  if (req.isPending) {
    key = "loading";
    body = (
      <div
        className="flex min-h-40 items-center justify-center"
        aria-busy="true"
      >
        <Spinner />
      </div>
    );
  } else if (req.error || !view) {
    key = "gone";
    body =
      req.error instanceof HttpError && req.error.status !== 404 ? (
        <Unreachable error={req.error} onRetry={() => void req.refetch()} />
      ) : (
        <>
          <div className="space-y-2">
            <AuthTitle>{t("signin.request.goneTitle")}</AuthTitle>
            <p className="text-fg-muted">{t("signin.request.gone")}</p>
          </div>
          <Button asChild variant="neutral" size="lg" className={PRIMARY_CLASS}>
            <a href="/">{t("signin.return.library")}</a>
          </Button>
        </>
      );
  } else if (
    (cardChooses && licenses.isPending) ||
    (current?.kind === "consent" && consent.isPending)
  ) {
    key = "loading";
    body = (
      <div
        className="flex min-h-40 items-center justify-center"
        aria-busy="true"
      >
        <Spinner />
      </div>
    );
  } else if (licenses.error || (current?.kind === "consent" && consent.error)) {
    key = "error";
    body = (
      <Unreachable
        error={licenses.error ?? consent.error}
        onRetry={() => {
          void licenses.refetch();
          void consent.refetch();
        }}
      />
    );
  } else if (current?.kind === "return") {
    key = "return";
    body = (
      <ReturnStep
        app={view.client.appName}
        product={view.client.appName}
        yours={current.yours}
        tier={current.tier}
        onReturn={() => leave(current.redirect)}
      />
    );
  } else if (current?.kind === "done") {
    key = "done";
    body = (
      <ReplacedDone
        app={view.client.appName}
        replaced={current.replaced}
        thisDevice={thisDeviceTitle(view)}
        onReturn={() => leave(current.redirect)}
      />
    );
  } else if (current?.kind === "replace" && lic) {
    key = "replace";
    body = (
      <ReplaceDeviceStep
        handle={handle}
        row={current.row}
        rows={lic.choices}
        app={view.client.appName}
        product={view.client.appName}
        developer={view.client.developerName ?? view.client.appName}
        thisDevice={thisDeviceTitle(view)}
        onBack={() => go({ kind: "choice" }, "back")}
        onConfirm={(device: DeviceRowModel) => {
          setChosen({ kind: "license", row: current.row, replace: device });
          go({ kind: "consent" });
        }}
      />
    );
  } else if (current?.kind === "consent" && consent.data) {
    key = "consent";
    body = (
      <ConsentStep
        view={consent.data}
        app={view.client.appName}
        product={view.client.appName}
        device={thisDeviceName(view)}
        chosen={effectiveChosen}
        busy={busy}
        error={error}
        onChange={chosen ? () => go({ kind: "choice" }, "back") : null}
        onContinue={() => void proceed()}
        onDeny={() => void deny()}
        onNotYou={() => void notYou()}
      />
    );
  } else if (lic?.state === "none") {
    key = "none";
    body = (
      <NoneStep
        person={{
          name: account.name,
          email: account.email,
          picture: account.avatarUrl ?? null,
        }}
        product={view.client.appName}
        keyHref={keyHrefFor(lic.getLicense, handle)}
        purchaseUrl={httpsOrNull(lic.getLicense?.purchaseUrl ?? null)}
        onOther={() => void notYou()}
        onCancel={() => void deny()}
        error={error}
      />
    );
  } else if (lic) {
    key = "choice";
    body = (
      <LicenseChoiceStep
        view={lic}
        product={view.client.appName}
        developer={view.client.developerName ?? view.client.appName}
        deviceName={thisDeviceName(view)}
        browser={view.deviceLabel === null}
        person={{
          name: account.name,
          email: account.email,
          picture: account.avatarUrl ?? null,
        }}
        onNotYou={() => void notYou()}
        keyHref={keyHrefFor(lic.getLicense, handle)}
        notice={notice}
        initialId={
          chosen?.kind === "license"
            ? chosen.row.id
            : chosen?.kind === "create"
              ? "create"
              : null
        }
        onUse={(pick) => {
          setNotice(null);
          setChosen(
            pick.kind === "create"
              ? { kind: "create", tierName: lic.create?.tierName ?? "" }
              : { kind: "license", row: pick.row, replace: null },
          );
          go({ kind: "consent" });
        }}
        onReplace={(row) => {
          setNotice(null);
          setChosen({ kind: "license", row, replace: null });
          go({ kind: "replace", row });
        }}
        onCancel={() => void deny()}
      />
    );
  } else {
    key = "loading";
    body = <Spinner />;
  }

  return (
    <AuthCard
      brand={brand}
      header={header}
      footer={footer}
      receipt={footer !== undefined}
      after={<LegalNav />}
      stepKey={key}
      focusKey={focusOnArrival ? 1 : 0}
      direction={direction}
    >
      {body}
    </AuthCard>
  );
}

/** A refusal in the catalog's words. */
function refusalText(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 429 || err.code === "rate_limited")
      return typeof err.retryAfter === "number"
        ? waitText(err.retryAfter)
        : t("signin.request.tooMany");
    if (err.status === 404) return t("signin.request.gone");
  }
  const copy = portalErrorCopy(err, { account: true });
  return copy.line;
}

function Unreachable({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  const copy = portalErrorCopy(error, { account: true });
  return (
    <>
      <div className="space-y-2">
        <AuthTitle>{copy.title}</AuthTitle>
        <p className="text-fg-muted">{copy.description}</p>
      </div>
      <Button
        variant="neutral"
        size="lg"
        className={PRIMARY_CLASS}
        onClick={onRetry}
      >
        {t("signin.retry")}
      </Button>
    </>
  );
}

function httpsOrNull(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** The Activate page on this origin, which returns to this card after the add. */
function keyHrefFor(
  get: { activateUrl: string; keyEntry: boolean } | null,
  handle: string,
): string | null {
  if (!get?.keyEntry) return null;
  try {
    const u = new URL(get.activateUrl, window.location.origin);
    u.searchParams.set("return", `/signin?request=${handle}`);
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

/** "No <Product> license in this account": never a dead end (§3.6 rule 6). */
function NoneStep({
  person,
  product,
  keyHref,
  purchaseUrl,
  onOther,
  onCancel,
  error,
}: {
  person: { name: string | null; email: string | null; picture: string | null };
  product: string;
  keyHref: string | null;
  purchaseUrl: string | null;
  onOther: () => void;
  onCancel: () => void;
  error: string | null;
}): React.ReactElement {
  const linkClass =
    "inline-flex min-h-11 items-center rounded-sm px-1 underline decoration-2 underline-offset-4 hover:text-fg-strong";
  return (
    <>
      <PersonRow {...person} onNotYou={onOther} />
      <div className="space-y-2">
        <AuthTitle>{t("signin.none.title", { product })}</AuthTitle>
        <p className="text-fg-muted">{t("signin.none.body")}</p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {keyHref ? (
        <Button asChild variant="neutral" size="lg" className={PRIMARY_CLASS}>
          <a href={keyHref}>{t("signin.choice.keyInstead")}</a>
        </Button>
      ) : purchaseUrl ? (
        <Button asChild variant="neutral" size="lg" className={PRIMARY_CLASS}>
          <a href={purchaseUrl} target="_blank" rel="noopener noreferrer">
            {t("signin.none.get", { product })}
          </a>
        </Button>
      ) : (
        <Button
          variant="neutral"
          size="lg"
          className={PRIMARY_CLASS}
          onClick={onOther}
        >
          {t("signin.none.otherAccount")}
        </Button>
      )}
      <QuietLinks>
        {keyHref && purchaseUrl ? (
          <a
            href={purchaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={linkClass}
          >
            {t("signin.none.get", { product })}
          </a>
        ) : null}
        {keyHref || purchaseUrl ? (
          <QuietLink onClick={onOther}>
            {t("signin.none.otherAccount")}
          </QuietLink>
        ) : null}
        <QuietLink onClick={onCancel}>{t("signin.cancel")}</QuietLink>
      </QuietLinks>
    </>
  );
}
