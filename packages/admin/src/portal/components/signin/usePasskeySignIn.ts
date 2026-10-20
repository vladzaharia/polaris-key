import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { t } from "../../../lib/copy.js";
import { portalApi, PortalApiError } from "../../api.js";
import { portalKeys } from "../../data.js";
import { rememberNudge, rememberVia } from "../../lastMethod.js";
import { announceSignedIn } from "../../session.js";
import {
  PasskeyError,
  conditionalPasskeysAvailable,
  passkeyAssertion,
  passkeysSupported,
  signalUnknownPasskey,
} from "../../webauthn.js";

/** What a failed passkey sign-in says, from the catalog (never the Worker's prose). */
function passkeyText(err: unknown): string {
  return err instanceof PasskeyError && err.reason === "cancelled"
    ? t("signin.passkey.cancelled")
    : err instanceof PasskeyError && err.reason === "unsupported"
      ? t("signin.passkey.unsupported")
      : err instanceof PortalApiError && err.status === 403
        ? t("signin.approve.disabled")
        : t("signin.passkey.failed");
}

/**
 * Sign in with a passkey (I-16): the Worker's options, the browser's assertion (a modal prompt
 * from the button, or the email field's autofill: conditional UI), the Worker's verify, then the
 * session. A passkey no account here holds is signalled to the browser to forget.
 *
 * The autofill offer is a long wait on one challenge. When the person picks a passkey and the
 * verify refuses (or the challenge ran out meanwhile), the failure shows in the same alert the
 * button uses and the offer restarts on fresh options; so does a failed modal attempt. Only a
 * dismissed prompt (`AbortError`, `NotAllowedError`) is silent.
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
  const wanted = React.useRef(false);
  const pending = React.useRef<AbortController | null>(null);

  /** One ceremony; `onAsserted` fires once the browser has produced an assertion. */
  const ceremony = React.useCallback(
    async (
      mediation: "conditional" | undefined,
      signal: AbortSignal | undefined,
      onAsserted: () => void,
    ): Promise<void> => {
      const { options } = await portalApi.passkeySignInOptions(returnTo());
      const response = await passkeyAssertion(options, [], {
        mediation,
        signal,
      });
      onAsserted();
      let out: Awaited<ReturnType<typeof portalApi.passkeySignInVerify>>;
      try {
        out = await portalApi.passkeySignInVerify(response);
      } catch (err) {
        if (err instanceof PortalApiError && err.unknownCredential)
          signalUnknownPasskey(options, response.id);
        throw err;
      }
      rememberVia("passkey");
      if (out.nudge) rememberNudge();
      announceSignedIn();
      await qc.invalidateQueries({ queryKey: portalKeys.me });
    },
    [qc, returnTo],
  );

  const begin = React.useCallback(async (): Promise<void> => {
    if (!wanted.current) return;
    pending.current?.abort();
    const ctl = new AbortController();
    pending.current = ctl;
    if (!(await conditionalPasskeysAvailable()) || ctl.signal.aborted) return;
    let asserted = false;
    try {
      await ceremony("conditional", ctl.signal, () => {
        asserted = true;
      });
    } catch (err) {
      if (ctl.signal.aborted) return;
      // A dismissed prompt is silent; a refusal after a pick is not.
      if (err instanceof PasskeyError && err.reason === "cancelled") return;
      if (!asserted) return;
      setError(passkeyText(err));
      void begin();
    }
  }, [ceremony]);

  const run = React.useCallback(async (): Promise<void> => {
    pending.current?.abort();
    setBusy(true);
    setError(null);
    try {
      await ceremony(undefined, undefined, () => undefined);
    } catch (err) {
      setError(passkeyText(err));
      void begin();
    } finally {
      setBusy(false);
    }
  }, [ceremony, begin]);

  const conditional = React.useCallback((): (() => void) => {
    if (!passkeysSupported()) return () => undefined;
    wanted.current = true;
    void begin();
    return () => {
      wanted.current = false;
      pending.current?.abort();
    };
  }, [begin]);

  return { busy, error, run, conditional };
}
