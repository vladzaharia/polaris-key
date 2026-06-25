// `<PolarisLogin>` — the drop-in sign-in card: an OIDC button plus a typed
// key-entry form. Themed entirely via the `--pk-*` custom properties the Provider sets, so
// it inherits the brand without any CSS-in-JS. All copy comes from the theme so it's fully
// localizable/brandable.
//
// Accessibility: the primary action (OIDC button) is auto-focused on mount; the key form
// submits on Enter; the input has an associated <label> and is wired to its error via
// `aria-describedby`; errors are `role="alert"`; busy/disabled states are announced with
// `aria-busy`. The whole card carries an accessible name (`aria-labelledby` → the title).

import { useId, useState, type CSSProperties, type FormEvent } from "react";
import { usePolarisAuth } from "../react/hooks.js";
import { usePolarisTheme } from "../react/hooks.js";

export interface PolarisLoginProps {
  /** Hide the typed-key card. */
  hideKeyEntry?: boolean;
  /** Extra className on the root. */
  className?: string;
  /** A node rendered above the card (overrides the theme logo for this instance). */
  logo?: import("react").ReactNode;
  /** Auto-focus the primary action on mount (default true). Disable when several login
   *  cards share a screen, to avoid focus fights. */
  autoFocus?: boolean;
}

const card: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "min(360px, 100%)",
  padding: "28px",
  background: "var(--pk-surface)",
  color: "var(--pk-text)",
  border: "1px solid var(--pk-border)",
  borderRadius: "var(--pk-radius)",
  fontFamily: "var(--pk-font-family)",
};

const primaryBtn: CSSProperties = {
  appearance: "none",
  cursor: "pointer",
  border: "none",
  padding: "12px 16px",
  borderRadius: "var(--pk-radius)",
  background: "var(--pk-accent)",
  color: "var(--pk-accent-text)",
  fontWeight: 600,
  fontSize: "15px",
  outlineColor: "var(--pk-ring)",
  outlineOffset: "2px",
};

const input: CSSProperties = {
  padding: "10px 12px",
  borderRadius: "var(--pk-radius)",
  border: "1px solid var(--pk-border)",
  background: "transparent",
  color: "var(--pk-text)",
  fontSize: "14px",
  outlineColor: "var(--pk-ring)",
  outlineOffset: "2px",
};

const secondaryBtn: CSSProperties = {
  ...primaryBtn,
  background: "transparent",
  color: "var(--pk-text)",
  border: "1px solid var(--pk-border)",
};

/** Map a `PolarisError` to a clearer, user-facing message when the adapter handed us a
 *  recognizable code/message; otherwise fall back to the raw message. The desktop adapter
 *  already humanizes machine-limit / unauthorized into `sign-in-failed` errors, so we key
 *  off the message text it produced AND the code, surfacing remediation guidance. */
function describeAuthError(err: { code?: string; message: string }): string {
  const msg = err.message ?? "";
  if (/device limit/i.test(msg) || err.code === "machine-limit") {
    return "This license has reached its device limit. Sign out on another device, or contact your administrator.";
  }
  if (/not accepted/i.test(msg) || err.code === "unauthorized") {
    return "That key was not accepted. Check it for typos and try again.";
  }
  if (err.code === "key-entry-unsupported") {
    return "Key entry isn't available here — use the sign-in button instead.";
  }
  if (err.code === "network") {
    return "We couldn't reach the licensing service. Check your connection and try again.";
  }
  return msg || "Sign-in failed. Please try again.";
}

export function PolarisLogin(props: PolarisLoginProps): JSX.Element {
  const theme = usePolarisTheme();
  const auth = usePolarisAuth();
  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);

  const titleId = useId();
  const keyInputId = useId();
  const errorId = useId();

  const showKeyEntry = auth.supportsKeyEntry && !props.hideKeyEntry;
  const logo = props.logo ?? theme.logo;
  const autoFocus = props.autoFocus ?? true;

  async function onSubmitKey(e: FormEvent): Promise<void> {
    e.preventDefault();
    setKeyError(null);
    try {
      await auth.submitKey(key.trim());
    } catch (err) {
      setKeyError(describeAuthError(err as { code?: string; message: string }));
    }
  }

  // Prefer the explicit key-entry error; otherwise surface the adapter's last error.
  const errorText = keyError
    ? keyError
    : auth.error
      ? describeAuthError(auth.error)
      : null;

  return (
    <section
      className={props.className}
      style={card}
      data-polaris-login=""
      aria-labelledby={titleId}
    >
      {logo ? (
        <div style={{ display: "flex", justifyContent: "center" }}>{logo}</div>
      ) : null}
      <div>
        <h2 id={titleId} style={{ margin: "0 0 4px", fontSize: "20px" }}>
          {theme.copy.signInTitle}
        </h2>
        <p
          style={{ margin: 0, color: "var(--pk-text-muted)", fontSize: "14px" }}
        >
          {theme.copy.signInSubtitle}
        </p>
      </div>

      <button
        type="button"
        style={primaryBtn}
        disabled={auth.busy}
        aria-busy={auth.busy}
        // Keep an accessible name even while the busy glyph ("…") shows.
        aria-label={theme.copy.oidcButtonLabel}
        autoFocus={autoFocus}
        onClick={() => {
          void auth.signInWithOidc();
        }}
        data-polaris-oidc=""
      >
        {auth.busy ? "…" : theme.copy.oidcButtonLabel}
      </button>

      {showKeyEntry ? (
        <form
          onSubmit={onSubmitKey}
          style={{ display: "flex", flexDirection: "column", gap: "8px" }}
        >
          <label
            htmlFor={keyInputId}
            style={{ fontSize: "13px", color: "var(--pk-text-muted)" }}
          >
            {theme.copy.keyEntryLabel}
          </label>
          <input
            id={keyInputId}
            style={input}
            value={key}
            placeholder={theme.copy.keyEntryPlaceholder}
            onChange={(e) => setKey(e.target.value)}
            aria-invalid={errorText ? true : undefined}
            aria-describedby={errorText ? errorId : undefined}
            data-polaris-key-input=""
          />
          <button
            type="submit"
            style={secondaryBtn}
            disabled={auth.busy || key.trim().length === 0}
            aria-busy={auth.busy}
          >
            {theme.copy.keySubmitLabel}
          </button>
        </form>
      ) : null}

      {errorText ? (
        <p
          id={errorId}
          style={{ margin: 0, color: "var(--pk-danger)", fontSize: "13px" }}
          role="alert"
        >
          {errorText}
        </p>
      ) : null}
    </section>
  );
}
