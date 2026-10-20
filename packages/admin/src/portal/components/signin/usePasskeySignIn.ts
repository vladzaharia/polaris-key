import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { sc } from "../../copy/signin.js";
import { portalApi, PortalApiError } from "../../api.js";
import { portalKeys } from "../../data.js";
import { rememberVia } from "../../lastMethod.js";
import { announceSignedIn } from "../../session.js";
import {
  PasskeyError,
  conditionalPasskeysAvailable,
  passkeyAssertion,
  passkeysSupported,
  signalUnknownPasskey,
} from "../../webauthn.js";

/**
 * Sign in with a passkey (I-16): the Worker's options, the browser's assertion (a modal prompt
 * from the button, or the email field's autofill: conditional UI), the Worker's verify, then the
 * session. A passkey no account here holds is signalled to the browser to forget.
 */
export function usePasskeySignIn(returnTo: () => string): {
  busy: boolean;
  error: string | null;
  /** The button: a modal prompt. */
  run: () => Promise<void>;
  /** Start the autofill offer; the returned function stops it. */
  conditional: () => () => void;
} {
  const qc = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const pending = React.useRef<AbortController | null>(null);

  const ceremony = React.useCallback(
    async (mediation?: "conditional", signal?: AbortSignal): Promise<void> => {
      const { options } = await portalApi.passkeySignInOptions(returnTo());
      const response = await passkeyAssertion(options, [], {
        mediation,
        signal,
      });
      try {
        await portalApi.passkeySignInVerify(response);
      } catch (err) {
        if (err instanceof PortalApiError && err.unknownCredential)
          signalUnknownPasskey(options, response.id);
        throw err;
      }
      rememberVia("passkey");
      announceSignedIn();
      await qc.invalidateQueries({ queryKey: portalKeys.me });
    },
    [qc, returnTo],
  );

  const run = React.useCallback(async (): Promise<void> => {
    pending.current?.abort();
    setBusy(true);
    setError(null);
    try {
      await ceremony();
    } catch (err) {
      setError(
        err instanceof PasskeyError && err.reason === "cancelled"
          ? sc("signin.passkey.cancelled")
          : err instanceof PasskeyError && err.reason === "unsupported"
            ? sc("signin.passkey.unsupported")
            : err instanceof PortalApiError && err.status === 403
              ? sc("signin.approve.disabled")
              : sc("signin.passkey.failed"),
      );
    } finally {
      setBusy(false);
    }
  }, [ceremony]);

  const conditional = React.useCallback((): (() => void) => {
    if (!passkeysSupported()) return () => undefined;
    const ctl = new AbortController();
    let live = true;
    void (async () => {
      if (!(await conditionalPasskeysAvailable()) || !live) return;
      pending.current = ctl;
      try {
        await ceremony("conditional", ctl.signal);
      } catch {
        // Aborted, dismissed or refused: the field and the button still work.
      }
    })();
    return () => {
      live = false;
      ctl.abort();
    };
  }, [ceremony]);

  return { busy, error, run, conditional };
}
