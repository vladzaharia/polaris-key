// `<PolarisLogin>` — the drop-in sign-in card: an OIDC button plus (desktop only) a typed
// key-entry form. Themed entirely via the `--pk-*` custom properties the Provider sets, so
// it inherits the brand without any CSS-in-JS. All copy comes from the theme so it's fully
// localizable/brandable. The key-entry card is hidden in browser mode (OIDC-only there).

import { useState, type CSSProperties, type FormEvent } from "react";
import { usePolarisAuth } from "../react/hooks.js";
import { usePolarisTheme } from "../react/hooks.js";

export interface PolarisLoginProps {
  /** Hide the typed-key card even on desktop. */
  hideKeyEntry?: boolean;
  /** Extra className on the root. */
  className?: string;
  /** A node rendered above the card (overrides the theme logo for this instance). */
  logo?: import("react").ReactNode;
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
};

const input: CSSProperties = {
  padding: "10px 12px",
  borderRadius: "var(--pk-radius)",
  border: "1px solid var(--pk-border)",
  background: "transparent",
  color: "var(--pk-text)",
  fontSize: "14px",
};

const secondaryBtn: CSSProperties = {
  ...primaryBtn,
  background: "transparent",
  color: "var(--pk-text)",
  border: "1px solid var(--pk-border)",
};

export function PolarisLogin(props: PolarisLoginProps): JSX.Element {
  const theme = usePolarisTheme();
  const auth = usePolarisAuth();
  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);

  const showKeyEntry = auth.supportsKeyEntry && !props.hideKeyEntry;
  const logo = props.logo ?? theme.logo;

  async function onSubmitKey(e: FormEvent): Promise<void> {
    e.preventDefault();
    setKeyError(null);
    try {
      await auth.submitKey(key.trim());
    } catch (err) {
      setKeyError((err as Error).message);
    }
  }

  return (
    <div className={props.className} style={card} data-polaris-login="">
      {logo ? <div style={{ display: "flex", justifyContent: "center" }}>{logo}</div> : null}
      <div>
        <h2 style={{ margin: "0 0 4px", fontSize: "20px" }}>{theme.copy.signInTitle}</h2>
        <p style={{ margin: 0, color: "var(--pk-text-muted)", fontSize: "14px" }}>
          {theme.copy.signInSubtitle}
        </p>
      </div>

      <button
        type="button"
        style={primaryBtn}
        disabled={auth.busy}
        onClick={() => {
          void auth.signInWithOidc();
        }}
        data-polaris-oidc=""
      >
        {auth.busy ? "…" : theme.copy.oidcButtonLabel}
      </button>

      {showKeyEntry ? (
        <form onSubmit={onSubmitKey} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <label style={{ fontSize: "13px", color: "var(--pk-text-muted)" }}>{theme.copy.keyEntryLabel}</label>
          <input
            style={input}
            value={key}
            placeholder={theme.copy.keyEntryPlaceholder}
            onChange={(e) => setKey(e.target.value)}
            data-polaris-key-input=""
          />
          <button type="submit" style={secondaryBtn} disabled={auth.busy || key.trim().length === 0}>
            {theme.copy.keySubmitLabel}
          </button>
        </form>
      ) : null}

      {keyError ? (
        <p style={{ margin: 0, color: "var(--pk-danger)", fontSize: "13px" }} role="alert">
          {keyError}
        </p>
      ) : auth.error ? (
        <p style={{ margin: 0, color: "var(--pk-danger)", fontSize: "13px" }} role="alert">
          {auth.error.message}
        </p>
      ) : null}
    </div>
  );
}
