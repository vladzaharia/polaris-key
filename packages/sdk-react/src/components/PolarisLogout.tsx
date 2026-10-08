// `<PolarisLogout>` — a branded sign-out button wired to `usePolarisAuth().signOut`. Themed
// via the same `--pk-*` custom properties as the login card so it inherits the brand.
//
// It disables on the IDENTITY service's busy flag alone. Under the pre-suite single `busy`
// scalar a background config refresh greyed this button out, which is a licensing detail
// reaching into an unrelated control; the per-service maps make "is sign-out in flight?" a
// question with an actual answer.

import { usePolarisAuth, usePolarisTheme } from "../react/hooks.js";
import { Button, quietStyle } from "./primitives/buttons.js";

export interface PolarisLogoutProps {
  /** Extra className on the button. */
  className?: string;
  /** Render a low-emphasis (text/ghost) button instead of the bordered default. */
  variant?: "outline" | "ghost";
  /** Override the themed label (defaults to `theme.copy.signOutLabel`). */
  label?: string;
}

export function PolarisLogout(props: PolarisLogoutProps): JSX.Element {
  const auth = usePolarisAuth();
  const theme = usePolarisTheme();
  const label = props.label ?? theme.copy.signOutLabel;

  return (
    <Button
      className={props.className}
      variant={props.variant === "ghost" ? "ghost" : "secondary"}
      style={{
        padding: quietStyle.padding,
        fontSize: quietStyle.fontSize,
        lineHeight: quietStyle.lineHeight,
        // Its own opaque ground, so the label never depends on the host's background.
        background: "var(--pk-surface)",
      }}
      busy={auth.busy}
      label={label}
      onClick={() => {
        void auth.signOut();
      }}
      data-polaris-logout=""
    >
      {label}
    </Button>
  );
}
