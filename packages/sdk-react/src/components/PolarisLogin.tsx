// `<PolarisLogin>` — the drop-in sign-in card: an OIDC button plus a typed key-entry form.
// Themed entirely via the `--pk-*` custom properties the Provider sets, so it inherits the
// brand without any CSS-in-JS. All copy comes from the theme so it's fully localizable.
//
// WHICH METHODS APPEAR is a capability question, not a mode question (D-21). The OIDC button
// appears when the product runs the IDENTITY service; the key form appears when it runs the
// LICENSE service, because a key activates a license and a config-only product has none. Both
// answers come from discovery when it answered and from `expectServices` when it did not —
// never from "assume on".
//
// Accessibility: the primary action (OIDC button) is auto-focused on mount; the key form
// submits on Enter; the input has an associated <label> and is wired to its error via
// `aria-describedby`; errors are `role="alert"`; busy/disabled states are announced with
// `aria-busy`. The whole card carries an accessible name (`aria-labelledby` → the title).

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { SPACE } from "@polaris-key/brand";
import { usePolarisAuth, usePolarisTheme } from "../react/hooks.js";
import { Button } from "./primitives/buttons.js";
import {
  Panel,
  actionPanel,
  dangerText,
  mutedText,
  titleText,
  typeStep,
} from "./primitives/card.js";
import { TextField } from "./primitives/input.js";
import { useWindowLayout } from "./primitives/layout.js";
import { screenLogo, themePoweredBy } from "./brand.js";
import { knownProductName, type PolarisTheme } from "./theme.js";
import { withManageKey, withManageReturn } from "@polaris-key/client-core";
import { describeError } from "../core/copy.js";

export interface PolarisLoginProps {
  /** Hide the typed-key card. */
  hideKeyEntry?: boolean;
  /** Extra className on the root. */
  className?: string;
  /** A node rendered above the card (overrides the theme logo for this instance; `null`
   *  renders none). */
  logo?: ReactNode;
  /** Auto-focus the primary action on mount (default true). Disable when several login
   *  cards share a screen, to avoid focus fights. */
  autoFocus?: boolean;
  /** Drop the card chrome (border, background, padding) when the form sits inside another
   *  card, such as the gate's "license expired" screen. */
  bare?: boolean;
  /** Where the customer portal sends the person back after "Replace a device" (PX-W8), as
   *  `return=`. The portal honours it only when it is one of the product's declared return
   *  targets; leave it unset to add none. */
  returnUrl?: string;
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

/** The user-facing sentence for a sign-in failure: the copy catalog's, chosen by the typed
 *  activation kind, then the server's code, then the SDK's code (SP-R03). Never the error's
 *  message text, which is diagnostic and unlocalized. */
function describeAuthError(err: unknown): string {
  return describeError(
    err && typeof err === "object"
      ? (err as Parameters<typeof describeError>[0])
      : null,
  );
}

/**
 * The line under the sign-in title: the integrator's `signInSubtitle` when set, otherwise one
 * that says what the card offers and, when the product's name is known, names it.
 */
export function signInLede(
  theme: PolarisTheme,
  methods: { signIn: boolean; key: boolean },
): string {
  if (theme.copy.signInSubtitle !== "") return theme.copy.signInSubtitle;
  const product = knownProductName(theme);
  if (methods.signIn && methods.key)
    return product
      ? `Sign in or enter a license key to use ${product}.`
      : "Sign in or use a license key to continue.";
  if (methods.signIn)
    return product ? `Sign in to use ${product}.` : "Sign in to continue.";
  if (methods.key)
    return product
      ? `Enter a license key to use ${product}.`
      : "Enter a license key to continue.";
  return product ? `Sign in to use ${product}.` : "Sign in to continue.";
}

/** The sign-in card: narrow, so the form reads as one centred column. */
const loginCard: CSSProperties = { width: "min(27.5rem, 100%)" };

const bareCard: CSSProperties = {
  width: "100%",
  padding: 0,
  border: "none",
  background: "transparent",
  textAlign: "left",
};

const divider: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: SPACE["3"],
  color: "var(--pk-text-muted)",
  ...typeStep("sm"),
};

const dividerRule: CSSProperties = {
  flex: 1,
  height: "1px",
  background: "var(--pk-border)",
};

export function PolarisLogin(props: PolarisLoginProps): JSX.Element {
  const theme = usePolarisTheme();
  const auth = usePolarisAuth();
  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyManageUrl, setKeyManageUrl] = useState<string | null>(null);

  const titleId = useId();
  const keyInputId = useId();
  const errorId = useId();

  const showOidcLogin = auth.supportsOidcLogin;
  const showKeyEntry = auth.supportsKeyEntry && !props.hideKeyEntry;
  const showNoMethods = !showOidcLogin && !showKeyEntry;
  const logo = props.logo !== undefined ? props.logo : screenLogo(theme);
  const autoFocus = props.autoFocus ?? true;
  // Full-bleed on a narrow window (the gate on a phone): the title sits in the middle of the
  // space above the sign-in methods, and the methods dock at the bottom, where a thumb is.
  const bleed = useWindowLayout()?.bleed === true;
  const docked: CSSProperties | null = bleed ? { marginTop: "auto" } : null;

  async function onSubmitKey(e: FormEvent): Promise<void> {
    e.preventDefault();
    setKeyError(null);
    setKeyManageUrl(null);
    try {
      await auth.submitKey(key.trim());
    } catch (err) {
      setKeyError(describeAuthError(err));
      setKeyManageUrl((err as { manageUrl?: string }).manageUrl ?? null);
    }
  }

  // Prefer the explicit key-entry error; otherwise surface the adapter's last error.
  const errorText = keyError
    ? keyError
    : auth.error
      ? describeAuthError(auth.error)
      : null;
  // PX-W8: the device-limit refusal's portal link, from the key entry just made or from the
  // adapter's last error.
  const manageUrl = keyError
    ? keyManageUrl
    : ((auth.error as { manageUrl?: string } | null | undefined)?.manageUrl ??
      null);

  // A refusal lands under the form, which on a short window (a phone on its side) is below the
  // fold: bring it, and "Replace a device" with it, into view.
  const errorRef = useRef<HTMLParagraphElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!errorText) return;
    (replaceRef.current ?? errorRef.current)?.scrollIntoView?.({
      block: "nearest",
    });
  }, [errorText, manageUrl]);

  return (
    <Panel
      className={props.className}
      style={props.bare ? bareCard : loginCard}
      data-polaris-login=""
      aria-labelledby={titleId}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: SPACE["5"],
          ...docked,
        }}
      >
        {logo ? (
          <div style={{ display: "flex", justifyContent: "center" }}>
            {logo}
          </div>
        ) : null}
        <div style={{ textAlign: "center" }}>
          <h2 id={titleId} style={titleText}>
            {theme.copy.signInTitle}
          </h2>
          <p style={mutedText} data-polaris-login-lede="">
            {signInLede(theme, { signIn: showOidcLogin, key: showKeyEntry })}
          </p>
        </div>
      </div>

      <div style={{ ...actionPanel, gap: SPACE["4"], ...docked }}>
        {showOidcLogin ? (
          <div style={actionPanel}>
            <Button
              variant="primary"
              disabled={auth.busy}
              busy={auth.busy}
              label={theme.copy.oidcButtonLabel}
              autoFocus={autoFocus}
              onClick={() => {
                void auth.signInWithOidc();
              }}
              data-polaris-oidc=""
            >
              {auth.busy ? "..." : theme.copy.oidcButtonLabel}
            </Button>
          </div>
        ) : null}

        {showOidcLogin && showKeyEntry ? (
          <div style={divider} aria-hidden="true">
            <span style={dividerRule} />
            <span>{theme.copy.orDivider}</span>
            <span style={dividerRule} />
          </div>
        ) : null}

        {showKeyEntry ? (
          <form onSubmit={onSubmitKey} style={actionPanel}>
            <TextField
              id={keyInputId}
              label={theme.copy.keyEntryLabel}
              value={key}
              placeholder={theme.copy.keyEntryPlaceholder}
              onChange={setKey}
              autoFocus={!showOidcLogin && autoFocus}
              invalid={Boolean(errorText)}
              errorId={errorText ? errorId : undefined}
              data-polaris-key-input=""
            />
            <Button
              variant="secondary"
              type="submit"
              disabled={auth.keyEntryBusy || key.trim().length === 0}
              busy={auth.keyEntryBusy}
            >
              {theme.copy.keySubmitLabel}
            </Button>
          </form>
        ) : null}

        {showNoMethods ? (
          <p style={mutedText} role="status">
            No sign-in methods are available.
          </p>
        ) : null}
      </div>

      {errorText ? (
        <p id={errorId} ref={errorRef} style={dangerText} role="alert">
          {errorText}
        </p>
      ) : null}

      {errorText && manageUrl ? (
        <Button
          ref={replaceRef}
          variant="secondary"
          label={theme.copy.freeDeviceLabel}
          onClick={() => {
            openManageUrl(manageUrl, {
              ...(props.returnUrl ? { returnUrl: props.returnUrl } : {}),
              ...(key.trim() ? { key: key.trim() } : {}),
            });
          }}
          data-polaris-free-device=""
        >
          {theme.copy.freeDeviceLabel}
        </Button>
      ) : null}

      {themePoweredBy(theme)}
    </Panel>
  );
}
