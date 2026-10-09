// `<PolarisLogin>` — the drop-in sign-in card: Sign in, and a license key behind "Use a license
// key". Themed entirely via the `--pk-*` custom properties the Provider sets; every string is a
// catalog value from the theme copy, so it is fully localizable.
//
// WHICH METHODS APPEAR is a capability question, not a mode question (D-21). Sign in appears
// when the product runs the IDENTITY service; the key form appears when it runs the LICENSE
// service, because a key activates a license and a config-only product has none. Both answers
// come from discovery when it answered and from `expectServices` when it did not.
//
// ERRORS have two homes: a sign-in failure under Sign in, a key failure under the key field,
// each wired to its control. Only a key that is itself wrong marks the field invalid. A
// device-limit refusal is not an error at all: the key is good and the license is full, so it
// is a neutral callout ("Your license is on 3 of 3 devices") with "Replace a device" as the one
// filled action, which opens the customer portal and re-tries the key when the person comes back.
//
// Accessibility: the first method takes focus on mount (never a text field on a touch screen);
// the key form submits on Enter; the field has a real <label>; errors are `role="alert"`;
// busy actions are announced with `aria-busy` and keep their labels.

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { SPACE } from "@polaris-key/brand";
import {
  isSignInRefusal,
  useAdapterState,
  useCtx,
  usePolarisAuth,
  usePolarisTheme,
} from "../react/hooks.js";
import type { OidcSignInHandle, PolarisError } from "../core/index.js";
import { Button } from "./primitives/buttons.js";
import {
  Panel,
  actionPanel,
  dangerText,
  mutedText,
  prettyText,
  screenTitle,
  stickyColumn,
  titleText,
  twoColumnCard,
} from "./primitives/card.js";
import { TextField } from "./primitives/input.js";
import { ExternalGlyph } from "./primitives/glyphs.js";
import { SignInHandoff } from "./SignInHandoff.js";
import { safeLink } from "./links.js";
import { useWindowLayout } from "./primitives/layout.js";
import { COARSE_POINTER, useMediaQuery } from "./primitives/media.js";
import { screenLogo, themePoweredBy } from "./brand.js";
import { knownProductName, type PolarisTheme } from "./theme.js";
import { formatCopy } from "./format.js";
import {
  deviceLimitOf,
  errorSentence,
  keyIsWrong,
  type ErrorLike,
} from "./errors.js";
import { withManageKey, withManageReturn } from "@polaris-key/client-core";

export interface PolarisLoginProps {
  /** Hide the typed-key card. */
  hideKeyEntry?: boolean;
  /** Extra className on the root. */
  className?: string;
  /** A node rendered above the card (overrides the theme logo for this instance; `null`
   *  renders none). */
  logo?: ReactNode;
  /** Focus the first sign-in method on mount (default true). Disable when several login cards
   *  share a screen, to avoid focus fights. */
  autoFocus?: boolean;
  /** Drop the card chrome (border, background, padding) when the form sits inside another
   *  card, such as the gate's "license expired" screen. */
  bare?: boolean;
  /** Where the customer portal sends the person back after "Replace a device" (PX-W8), as
   *  `return=`. The portal honours it only when it is one of the product's declared return
   *  targets; leave it unset to add none. */
  returnUrl?: string;
  /**
   * @internal The gate's expired and revoked screens set `false`: the card drops its identity,
   * title and lede and renders the sign-in methods only, under the screen's own title.
   */
  heading?: boolean;
  /**
   * @internal The gate's expired and revoked screens set `true`: the old key is not the one to
   * type, so the key button reads "Use a different key".
   */
  differentKey?: boolean;
}

/**
 * Open the device-limit refusal link (PX-W8) in a new tab: the app's return URL as `return=`
 * and, on an `/activate` link, the typed key as the fragment `#key=` (a fragment never reaches
 * a server). Only ever called from a click.
 */
export function openManageUrl(
  manageUrl: string,
  opts: { returnUrl?: string; key?: string } = {},
): string {
  let url = manageUrl;
  if (opts.returnUrl) url = withManageReturn(url, opts.returnUrl);
  if (opts.key) url = withManageKey(url, opts.key);
  if (typeof window !== "undefined" && typeof window.open === "function")
    window.open(url, "_blank", "noopener,noreferrer");
  return url;
}

/** The sign-in title: "Welcome to {product}" once the product's name is known. */
export function signInTitle(theme: PolarisTheme): string {
  const product = knownProductName(theme);
  return product
    ? formatCopy(theme.copy.welcomeTitle, { product })
    : theme.copy.signInTitle;
}

/** The sign-in card: narrow, so the form reads as one column. */
const loginCard: CSSProperties = { width: "min(27.5rem, 100%)" };

/** A device-limit callout: neutral (the key is good), default text on the sunken surface. */
const callout: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: SPACE["1"],
  padding: SPACE["3"],
  borderRadius: "var(--pk-control-radius, var(--pk-radius))",
  background: "var(--pk-surface-sunken, var(--pk-surface))",
  color: "var(--pk-text)",
  fontSize: mutedText.fontSize,
  lineHeight: mutedText.lineHeight,
};

/** The refusal a license error carries for this card, if it is one (`isSignInRefusal`). */
function keyRefusal(err: PolarisError | null | undefined): PolarisError | null {
  return err && isSignInRefusal(err) ? err : null;
}

export const PolarisLogin = forwardRef<HTMLElement, PolarisLoginProps>(
  function PolarisLogin(props, ref) {
    const theme = usePolarisTheme();
    const auth = usePolarisAuth();
    const { adapter } = useCtx();
    const state = useAdapterState(adapter);
    const layout = useWindowLayout();
    const coarse = useMediaQuery(COARSE_POINTER);
    const heading = props.heading ?? true;
    const autoFocus = props.autoFocus ?? true;
    // The card's own placement in a window; a bare card nested in another screen has none.
    const inWindow = layout !== null && !props.bare;
    const bleed = inWindow && layout.bleed;
    const twoColumn = inWindow && layout.twoColumn;

    const showOidc = auth.supportsOidcLogin;
    const showKey = auth.supportsKeyEntry && !props.hideKeyEntry;
    const keyOnly = showKey && !showOidc;
    const showNoMethods = !showOidc && !showKey;

    const [key, setKey] = useState("");
    const [keyOpened, setKeyOpened] = useState(false);
    const [keyErr, setKeyErr] = useState<ErrorLike | null>(() =>
      keyRefusal(state.error.license),
    );
    const [signInErr, setSignInErr] = useState<ErrorLike | null>(
      () => state.error.identity,
    );

    // The device-code hand-off of a sign-in in progress (bearer mode, and a desktop host that
    // reports a code), and whether its code has run out.
    const [handle, setHandle] = useState<OidcSignInHandle | null>(null);
    const [handoffExpired, setHandoffExpired] = useState(false);

    // A refusal the adapter reports (this card's attempt, or another's) lands in its slot; a
    // slot this card cleared stays clear until the adapter reports a new one.
    const licenseError = state.error.license;
    const identityError = state.error.identity;
    useEffect(() => {
      const refusal = keyRefusal(licenseError);
      if (refusal) setKeyErr(refusal);
    }, [licenseError]);
    useEffect(() => {
      if (!identityError) return;
      setSignInErr(identityError);
      // A sign-in that failed ends the hand-off, except one already showing its own expiry.
      if (!handoffExpired) setHandle(null);
    }, [identityError, handoffExpired]);

    const titleId = useId();
    const keyInputId = useId();
    const keyErrorId = useId();
    const signInErrorId = useId();
    const browserLineId = useId();
    const cardRef = useRef<HTMLElement | null>(null);
    const fieldRef = useRef<HTMLInputElement>(null);
    const replaceRef = useRef<HTMLButtonElement>(null);
    const keyErrorRef = useRef<HTMLParagraphElement>(null);

    const limit = deviceLimitOf(keyErr);
    const keyFormOpen = keyOnly || keyOpened || keyErr !== null;
    const trimmed = key.trim();

    // A key submitted from this card, so a refusal that follows may move focus and scroll; a
    // refusal already standing when the card mounts never scrolls the host's page.
    const submitted = useRef(false);
    // "Replace a device" opened the portal: the key is tried again when the person comes back.
    const awaitingReturn = useRef(false);

    const submitKey = useCallback(async (): Promise<void> => {
      const value = key.trim();
      if (!value || auth.keyEntryBusy) return;
      setKeyErr(null);
      setSignInErr(null);
      submitted.current = true;
      try {
        await auth.submitKey(value);
      } catch (err) {
        setKeyErr(
          err && typeof err === "object"
            ? (err as ErrorLike)
            : { code: "unknown" },
        );
      }
    }, [key, auth]);

    const latestSubmit = useRef(submitKey);
    latestSubmit.current = submitKey;

    useEffect(() => {
      if (typeof window === "undefined") return;
      const back = (): void => {
        if (!awaitingReturn.current || document.visibilityState === "hidden")
          return;
        awaitingReturn.current = false;
        void latestSubmit.current();
      };
      window.addEventListener("focus", back);
      document.addEventListener("visibilitychange", back);
      return () => {
        window.removeEventListener("focus", back);
        document.removeEventListener("visibilitychange", back);
      };
    }, []);

    // After a refusal from this card: focus "Replace a device" (the way out), and bring the
    // refusal into view on a short window.
    useEffect(() => {
      if (!keyErr || !submitted.current) return;
      submitted.current = false;
      const target = replaceRef.current ?? keyErrorRef.current;
      if (replaceRef.current) replaceRef.current.focus();
      target?.scrollIntoView?.({ block: "nearest" });
    }, [keyErr]);

    // Initial focus: the first method. A key-only card on a touch screen focuses itself rather
    // than the field, which would raise the keyboard over the screen.
    useEffect(() => {
      if (!autoFocus || !keyOnly || !coarse) return;
      cardRef.current?.focus();
      // Mount only.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const [focusField, setFocusField] = useState(false);
    useEffect(() => {
      if (!focusField) return;
      setFocusField(false);
      fieldRef.current?.focus();
    }, [focusField]);

    function onSubmit(e: FormEvent): void {
      e.preventDefault();
      void submitKey();
    }

    // Where focus goes back to when the hand-off closes: the button that opened it.
    const oidcRef = useRef<HTMLButtonElement>(null);
    const [restoreFocus, setRestoreFocus] = useState(false);
    useEffect(() => {
      if (!restoreFocus || handle) return;
      setRestoreFocus(false);
      oidcRef.current?.focus();
    }, [restoreFocus, handle]);

    function signIn(): void {
      setKeyErr(null);
      setSignInErr(null);
      setHandoffExpired(false);
      void Promise.resolve(auth.signInWithOidc())
        .then((started) => {
          // The cookie page navigates away and never gets here; a bearer page or a host that
          // reports a code hands back what to show.
          if (
            started &&
            (started.userCode || safeLink(started.verificationUrl))
          )
            setHandle(started);
        })
        .catch(() => undefined);
    }

    function cancelHandoff(): void {
      handle?.cancel?.();
      setHandle(null);
      setHandoffExpired(false);
      setRestoreFocus(true);
    }

    function signInAgain(): void {
      handle?.cancel?.();
      setHandle(null);
      setHandoffExpired(false);
      signIn();
    }

    function replace(): void {
      if (!limit) return;
      awaitingReturn.current = true;
      openManageUrl(limit.manageUrl, {
        ...(props.returnUrl ? { returnUrl: props.returnUrl } : {}),
        ...(trimmed ? { key: trimmed } : {}),
      });
    }

    const product = knownProductName(theme) ?? theme.copy.productName;
    const counts =
      limit?.activation?.deviceCount !== undefined &&
      limit.activation.limit !== undefined
        ? {
            used: limit.activation.deviceCount,
            limit: limit.activation.limit,
          }
        : null;

    const identitySize = layout && !layout.short && inWindow ? "6rem" : "4rem";
    const logo =
      props.logo !== undefined ? props.logo : screenLogo(theme, identitySize);
    const subtitle = theme.copy.signInSubtitle;

    return (
      <Panel
        ref={(node) => {
          cardRef.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        className={props.className}
        bare={props.bare}
        style={{
          ...loginCard,
          ...(props.bare
            ? { width: "100%", padding: 0, textAlign: "start" }
            : null),
          ...(twoColumn ? twoColumnCard : null),
        }}
        tabIndex={keyOnly && coarse ? -1 : undefined}
        data-polaris-login=""
        {...(inWindow ? { "data-polaris-card": "" } : {})}
        aria-labelledby={heading ? titleId : undefined}
      >
        {/* On a full-bleed window the head sits in the upper third of the space above the
            methods, which dock at the bottom: spacers growing 1 above and 2 below it. */}
        {bleed && heading ? (
          <div aria-hidden="true" style={{ flexGrow: 1, minHeight: 0 }} />
        ) : null}
        {heading ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: twoColumn ? "flex-start" : "center",
              gap: SPACE["4"],
              textAlign: twoColumn ? "start" : "center",
              ...(twoColumn ? stickyColumn : null),
            }}
            data-polaris-head=""
          >
            {logo ? <div style={{ display: "flex" }}>{logo}</div> : null}
            <div>
              <h2
                id={titleId}
                style={inWindow ? screenTitle : titleText}
                dir="auto"
              >
                {handle && !handoffExpired
                  ? theme.copy.handoffTitle
                  : signInTitle(theme)}
              </h2>
              {subtitle && !handle ? (
                <p
                  style={{ ...mutedText, ...prettyText, marginTop: SPACE["2"] }}
                >
                  {subtitle}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
        {bleed && heading ? (
          <div aria-hidden="true" style={{ flexGrow: 2, minHeight: 0 }} />
        ) : null}

        {handle ? (
          <SignInHandoff
            theme={theme}
            handle={handle}
            onCancel={cancelHandoff}
            onAgain={signInAgain}
            onExpired={setHandoffExpired}
          />
        ) : (
          <div
            style={{ ...actionPanel, gap: SPACE["3"] }}
            data-polaris-methods=""
          >
            {showOidc ? (
              <Button
                ref={oidcRef}
                variant={limit ? "secondary" : "primary"}
                busy={auth.busy}
                label={theme.copy.oidcButtonLabel}
                autoFocus={autoFocus}
                describedBy={signInErr ? signInErrorId : undefined}
                onClick={signIn}
                data-polaris-oidc=""
              >
                {theme.copy.oidcButtonLabel}
              </Button>
            ) : null}
            {signInErr ? (
              <p
                id={signInErrorId}
                role="alert"
                style={dangerText}
                data-polaris-signin-error=""
              >
                {errorSentence(signInErr)}
              </p>
            ) : null}

            {showKey && !keyFormOpen ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setKeyOpened(true);
                  setFocusField(true);
                }}
                data-polaris-use-key=""
              >
                {props.differentKey
                  ? theme.copy.differentKeyLabel
                  : theme.copy.useKeyLabel}
              </Button>
            ) : null}

            {showKey && keyFormOpen ? (
              <form
                onSubmit={onSubmit}
                noValidate
                style={actionPanel}
                data-polaris-key-form=""
              >
                <TextField
                  ref={fieldRef}
                  id={keyInputId}
                  label={theme.copy.keyEntryLabel}
                  value={key}
                  placeholder={theme.copy.keyEntryPlaceholder}
                  onChange={(value) => {
                    setKey(value);
                    setKeyErr(null);
                  }}
                  autoFocus={keyOnly && autoFocus}
                  invalid={keyIsWrong(keyErr)}
                  errorId={keyErr && !limit ? keyErrorId : undefined}
                  data-polaris-key-input=""
                />
                {keyErr && !limit ? (
                  <p
                    id={keyErrorId}
                    ref={keyErrorRef}
                    role="alert"
                    style={dangerText}
                    data-polaris-key-error=""
                  >
                    {errorSentence(keyErr)}
                  </p>
                ) : null}
                {limit ? (
                  <div
                    style={callout}
                    role="status"
                    data-polaris-device-limit=""
                  >
                    {counts ? (
                      <span style={{ fontWeight: 500 }}>
                        {formatCopy(theme.copy.deviceLimitHeading, counts)}
                      </span>
                    ) : null}
                    <span id={browserLineId}>
                      {formatCopy(theme.copy.deviceLimitBrowser, { product })}
                    </span>
                  </div>
                ) : null}
                {limit ? (
                  <Button
                    ref={replaceRef}
                    variant="primary"
                    label={theme.copy.freeDeviceLabel}
                    describedBy={browserLineId}
                    onClick={replace}
                    data-polaris-free-device=""
                  >
                    {theme.copy.freeDeviceLabel}
                    <ExternalGlyph />
                  </Button>
                ) : null}
                <Button
                  variant={keyOnly && !limit ? "primary" : "secondary"}
                  type="submit"
                  disabled={trimmed.length === 0}
                  busy={auth.keyEntryBusy}
                  data-polaris-key-submit=""
                >
                  {theme.copy.keySubmitLabel}
                </Button>
              </form>
            ) : null}

            {showNoMethods ? (
              <p style={mutedText} role="status">
                {theme.copy.noMethodsLabel}
              </p>
            ) : null}
            {themePoweredBy(theme)}
          </div>
        )}
      </Panel>
    );
  },
);
