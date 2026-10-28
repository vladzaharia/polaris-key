// `useLicenseChoice(grant)` (I-10a.11, identity.choice): the licence choice an app shows itself
// after `signIn` answered `{kind: "choose", grant}`. Loading, the view, `devices(licenseId)`,
// `complete`, `cancel` and the grant's expiry, over `usePolarisAuth().choice`.
//
// A refusal the Worker answers is state, not a throw: `refusal` holds the last one, and a
// `device_limit` or `license_choice_required` refusal swaps in the fresh `view` to choose from
// again. A thrown error (network, 5xx, unsupported) lands in `error` and leaves the grant open.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChoiceCancelResult,
  ChoiceCompleteResult,
  ChoiceRefusal,
  ChoiceViewResult,
  LicenseChoice,
  LicenseChoiceView,
  PolarisError,
  ReplaceView,
} from "../core/index.js";
import { useCtx } from "./hooks.js";

/** The grant lives 300 seconds (WIRE-CONTRACT-V4 §12.5.1). */
export const DEFAULT_GRANT_SECONDS = 300;

export type LicenseChoiceStatus =
  /** Reading the view. */
  | "loading"
  /** The view is on screen. */
  | "ready"
  /** A `complete` or `cancel` is in flight. */
  | "working"
  /** `complete` succeeded: the device holds the identity's token. */
  | "done"
  /** `cancel` succeeded: no token, the sign-in is over. */
  | "cancelled"
  /** The grant is spent or past its lifetime (`invalid_grant`, or `expiresIn` passed). */
  | "expired"
  /** The view could not be read; see `error` or `refusal`. */
  | "failed";

export interface UseLicenseChoiceOptions {
  /** The `choices` the `choose` outcome carried: shown at once, with no read. */
  initial?: LicenseChoiceView;
  /** Seconds the grant lives (the outcome's `expiresIn`). Default 300. */
  expiresIn?: number;
}

export interface UseLicenseChoice {
  status: LicenseChoiceStatus;
  /** The licences to choose from; null until read. */
  view: LicenseChoiceView | null;
  /** The last refusal the Worker answered, or null. Cleared by the next call. */
  refusal: ChoiceRefusal | null;
  /** The last thrown error (network, server, unsupported), or null. */
  error: PolarisError | null;
  /** After `complete` with `keep`: the device kept a licence outside the account, so `attach`
   *  may follow. */
  attachable: boolean;
  /** The result of the `complete` that finished the choice. */
  completed: Extract<ChoiceCompleteResult, { kind: "ok" }> | null;
  /** The devices on a full licence, for Replace. */
  devices(licenseId: string): Promise<ChoiceViewResult<ReplaceView>>;
  complete(choice: LicenseChoice): Promise<ChoiceCompleteResult>;
  cancel(): Promise<ChoiceCancelResult>;
  /** Read the view again. */
  reload(): Promise<void>;
}

export function useLicenseChoice(
  grant: string | null,
  opts: UseLicenseChoiceOptions = {},
): UseLicenseChoice {
  const { adapter } = useCtx();
  const choice = adapter.choice;
  const [status, setStatus] = useState<LicenseChoiceStatus>(
    opts.initial ? "ready" : "loading",
  );
  const [view, setView] = useState<LicenseChoiceView | null>(
    opts.initial ?? null,
  );
  const [refusal, setRefusal] = useState<ChoiceRefusal | null>(null);
  const [error, setError] = useState<PolarisError | null>(null);
  const [attachable, setAttachable] = useState(false);
  const [completed, setCompleted] =
    useState<UseLicenseChoice["completed"]>(null);
  const alive = useRef(true);
  const initial = useRef(opts.initial);
  const settled = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** A refusal as state: a spent grant ends the choice; a fixable one brings the fresh view. */
  const refuse = useCallback((r: ChoiceRefusal, whileLoading: boolean) => {
    setRefusal(r);
    if (r.code === "invalid_grant") {
      settled.current = true;
      setStatus("expired");
      return;
    }
    if (r.view) setView(r.view);
    setStatus(whileLoading ? "failed" : "ready");
  }, []);

  const load = useCallback(async () => {
    if (grant === null) return;
    setStatus("loading");
    setRefusal(null);
    setError(null);
    try {
      const r = await choice.licenses(grant);
      if (!alive.current) return;
      if (r.kind === "ok") {
        setView(r.view);
        setStatus("ready");
      } else refuse(r, true);
    } catch (e) {
      if (!alive.current) return;
      setError(e as PolarisError);
      setStatus("failed");
    }
  }, [grant, choice, refuse]);

  useEffect(() => {
    settled.current = false;
    if (grant === null) return;
    if (initial.current) {
      setView(initial.current);
      setStatus("ready");
      initial.current = undefined;
      return;
    }
    void load();
  }, [grant, load]);

  // The grant's lifetime: past it, the choice is expired without another round trip.
  const lifetime = opts.expiresIn ?? DEFAULT_GRANT_SECONDS;
  useEffect(() => {
    if (grant === null) return;
    const t = setTimeout(() => {
      if (!settled.current) setStatus("expired");
    }, lifetime * 1000);
    return () => clearTimeout(t);
  }, [grant, lifetime]);

  /** One call against the grant: clear the last refusal and error, run it, and keep what it
   *  answered as state. `settle` runs on the `kind: "ok"` answer; a refusal goes to `refuse`; a
   *  throw is `error` and reopens the choice. */
  const call = useCallback(
    async <R extends { kind: string }>(
      working: boolean,
      run: (grant: string) => Promise<R>,
      settle: (ok: Exclude<R, ChoiceRefusal>) => void,
    ): Promise<R> => {
      if (grant === null) throw new Error("useLicenseChoice has no grant.");
      if (working) setStatus("working");
      setRefusal(null);
      setError(null);
      try {
        const r = await run(grant);
        if (!alive.current) return r;
        if (r.kind === "refused") refuse(r as unknown as ChoiceRefusal, false);
        else settle(r as Exclude<R, ChoiceRefusal>);
        return r;
      } catch (e) {
        if (alive.current) {
          setError(e as PolarisError);
          if (working) setStatus("ready");
        }
        throw e;
      }
    },
    [grant, refuse],
  );

  const devices = useCallback(
    (licenseId: string) =>
      call(
        false,
        (g) => choice.devices(g, licenseId),
        () => undefined,
      ),
    [call, choice],
  );

  const complete = useCallback(
    (input: LicenseChoice) =>
      call(
        true,
        (g) => choice.complete(g, input),
        (ok) => {
          settled.current = true;
          setCompleted(ok as NonNullable<UseLicenseChoice["completed"]>);
          setAttachable((ok as { attachable?: true }).attachable === true);
          setStatus("done");
        },
      ),
    [call, choice],
  );

  const cancel = useCallback(
    () =>
      call(
        true,
        (g) => choice.cancel(g),
        () => {
          settled.current = true;
          setStatus("cancelled");
        },
      ),
    [call, choice],
  );

  return {
    status,
    view,
    refusal,
    error,
    attachable,
    completed,
    devices,
    complete,
    cancel,
    reload: load,
  };
}
