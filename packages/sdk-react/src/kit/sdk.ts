"use client";
// The drop-in's SDK half (UI-KITS.md §4.2, DL18): inside `<PolarisKeyProvider>`, `<PolarisKeyGate>`
// starts itself. This hook maps the provider's live state onto ui-core's `UiInput` and turns the
// kit's controls into SDK calls: sign in (with the device-code hand-off a desktop host reports),
// activate a key, the device-limit link (PX-W8: validated, the app's return URL and the typed
// key added, the key tried again on return), retry, reconnect and sign out. The models decide
// every screen; nothing here draws.

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type {
  AutoOutcome,
  SignInSessionHandle,
  UiInput,
} from "@polaris-key/ui-core";
import {
  gateInput,
  openManage,
  type GateStep,
} from "@polaris-key/ui-core/browser";

import { PolarisContext } from "../react/context.js";
import { useAdapterState } from "../react/hooks.js";
import type {
  OidcSignInHandle,
  PolarisAdapter,
  PolarisState,
} from "../core/index.js";

import type { AddFlow } from "./holderGate.js";
import { openLink, safeLink } from "./links.js";

export { gateInput, type GateStep };

/** The gate's steps: the key and hand-off steps, and the in-app sign-in form (`signin`). */
export type SdkStep = GateStep | "signin";

/** ActivateDone and AddToAccount show over the license that just activated: only the person
 *  leaves them (UK-42). */
const isHolderStep = (s: SdkStep): boolean => s === "done" || s === "add";

/** `Feature.identityAutosignin`; the generated table stays out of the gate's first load. */
const AUTOSIGNIN = "identity.autosignin";

/** The longest the gate holds its checking screen for automatic sign-in. */
const AUTO_WAIT_MS = 10_000;

/** What `<PolarisKeyGate>` needs from the SDK. */
export interface SdkGate {
  adapter: PolarisAdapter;
  input: UiInput;
  step: SdkStep;
  /** What automatic sign-in found, for the sign-in form to show first (null: the methods). */
  seed: AutoOutcome | null;
  /** The control that opened the current step, so Back returns focus to it. */
  opener: string | null;
  act(key: string): void;
  edit(field: string, value: string): void;
  /** The line a finished sign-in or key activation leaves over the app for a few seconds. */
  toast: GateToast | null;
}

/** A toast's copy key and arguments (the entries left, or who signed in under which tier). */
export interface GateToast {
  key: string;
  args: Record<string, string | number>;
}

/** The SDK-driven gate, or `null` outside `<PolarisKeyProvider>` (the gate then takes `input`). */
export function useSdkGate(
  opts: { returnUrl?: string; locale?: string } = {},
): SdkGate | null {
  const ctx = useContext(PolarisContext);
  // The hooks run whether or not a provider exists; with none they hold an inert state.
  const adapter = ctx?.adapter ?? null;
  const state = useAdapterState(adapter ?? INERT);
  const [step, setStep] = useState<SdkStep>("home");
  // Automatic sign-in: pending while the one run at boot is out, then what it found.
  const [auto, setAuto] = useState<{
    pending: boolean;
    seed: AutoOutcome | null;
  }>({ pending: false, seed: null });
  const autoStarted = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [key, setKey] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [handle, setHandle] = useState<OidcSignInHandle | null>(null);
  // The refusal the person left behind: leaving the step, or editing the key, clears it (DL7),
  // and the key they typed stays in the field.
  const [dismissed, setDismissed] = useState<unknown>(null);
  const [opener, setOpener] = useState<string | null>(null);
  const errorRef = useRef<unknown>(null);
  errorRef.current = state.error.license;
  const [toast, setToast] = useState<GateToast | null>(null);
  // A sign-in that could not start from a refusal step: its callout (never a silent nothing).
  const [signInFailed, setSignInFailed] = useState(false);
  // Activation without an account (UK-42). The license key a gate activation took is held in
  // memory only: for the portal hand-off while Identity is off and for the owned sign-in. It is
  // never in a snapshot or a view's input, never logged, stored or put in a URL query, and is
  // dropped when the person leaves ActivateDone, cancels or the gate unmounts.
  const heldKey = useRef<string | null>(null);
  // A key activation is in flight: the state it causes must not end the Done step.
  const activating = useRef(false);
  // The Done and Add steps are wanted: set the moment a key activates (the render that shows the
  // step comes later, and a state change in between must not end it), cleared when they are left.
  const holding = useRef(false);
  const stepRef = useRef<SdkStep>("home");
  stepRef.current = step;
  const addFlow = useRef<AddFlow | null>(null);
  const addToken = useRef(0);
  const [addState, redrawAdd] = useReducer((n: number) => n + 1, 0);
  // The sign-in a holder flow runs in this page: one at a time.
  const session = useRef<SignInSessionHandle | null>(null);
  const owning = useRef(false);
  // Where AddToAccount opened from: ActivateDone, or a screen of the app (the settings row).
  const addFrom = useRef<SdkStep>("home");
  // The toast lasts a few seconds.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // The platform's Back steps back through the gate: each step past Welcome is one history entry.
  const pushed = useRef(false);
  const skipPop = useRef(false);
  /** Leave AddToAccount: its model and its sign-in are both cancelled. */
  const dropAdd = useCallback(() => {
    addToken.current++;
    const f = addFlow.current;
    addFlow.current = null;
    if (f) f.drop();
    else {
      const h = session.current;
      session.current = null;
      if (h) void Promise.resolve(h.cancel()).catch(() => {});
    }
    redrawAdd();
  }, []);
  /** Leave Done and AddToAccount: what they held is spent. */
  const dropHolder = useCallback(() => {
    heldKey.current = null;
    holding.current = false;
    dropAdd();
  }, [dropAdd]);
  const toHome = useCallback(() => {
    dropHolder();
    handleRef.current?.cancel?.();
    setHandle(null);
    setStep("home");
    // What the ladder found is spent (its grant went with the form).
    setAuto((a) => ({ ...a, seed: a.seed ? { kind: "needsSignIn" } : null }));
    setDismissed(errorRef.current);
    setSubmitted(false);
  }, [dropHolder]);
  const enter = useCallback((next: SdkStep, from: string) => {
    setOpener(from);
    setStep(next);
    if (typeof history !== "undefined" && !pushed.current) {
      try {
        history.pushState({ ...(history.state ?? {}), pkGate: next }, "");
        pushed.current = true;
      } catch {
        // A sandboxed frame has no history: Back still works on screen.
      }
    }
  }, []);
  const leave = useCallback(() => {
    toHome();
    if (pushed.current) {
      pushed.current = false;
      skipPop.current = true;
      try {
        history.back();
      } catch {
        skipPop.current = false;
      }
    }
  }, [toHome]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const on = (): void => {
      if (skipPop.current) {
        skipPop.current = false;
        return;
      }
      if (!pushed.current) return;
      pushed.current = false;
      toHome();
    };
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, [toHome]);

  // The hand-off's countdown (DL14: at 0:00 the view goes to expired while any poll finishes).
  const [secondsLeft, setSecondsLeft] = useState<number | undefined>(undefined);
  const expiresAt = handle?.expiresAt;
  useEffect(() => {
    if (expiresAt === undefined) {
      setSecondsLeft(undefined);
      return;
    }
    const tick = () => setSecondsLeft(expiresAt - Date.now() / 1000);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  // A hand-off that goes away stops the sign-in it started.
  const handleRef = useRef(handle);
  handleRef.current = handle;
  useEffect(
    () => () => {
      handleRef.current?.cancel?.();
      // Detaching ends the holder flows too (and drops the held key).
      heldKey.current = null;
      addToken.current++;
      addFlow.current?.drop();
      addFlow.current = null;
      const h = session.current;
      session.current = null;
      if (h) void Promise.resolve(h.cancel()).catch(() => {});
    },
    [],
  );
  // A sign-in that lands, or a license that holds, ends the flow's local steps.
  const nameRef = useRef<string | undefined>(undefined);
  nameRef.current = state.profile?.name ?? state.profile?.email;
  const tierRef = useRef<unknown>(undefined);
  tierRef.current = state.entitlements?.tier;
  useEffect(() => {
    if (state.status !== "needs-activation" && state.phase !== "loading") {
      // A sign-in that landed names who signed in and under which tier (when both are known).
      if (
        handleRef.current &&
        nameRef.current &&
        typeof tierRef.current === "string"
      )
        setToast({
          key: "signin.desktop.toast",
          args: { name: nameRef.current, tier: tierRef.current },
        });
      handleRef.current?.cancel?.();
      setHandle(null);
      // ActivateDone and AddToAccount stay over the license that just activated.
      if (
        !activating.current &&
        !holding.current &&
        !isHolderStep(stepRef.current)
      ) {
        setStep("home");
        pushed.current = false;
      }
    }
  }, [state.status, state.phase]);
  // Automatic sign-in: once at boot, when the page needs one and the product can sign in. What
  // it found steps the gate into the in-app form (a confirm, the license list, the device
  // limit); a sign-in that landed moves the license state by itself.
  const autoOn =
    ctx !== null &&
    ctx.autoSignIn !== false &&
    typeof adapter?.autoSignIn === "function";
  const identityOn = state.capabilities?.identity.enabled === true;
  // The checking screen waits for the ladder only where the build has one to run.
  const holds = autoOn && adapter?.supports(AUTOSIGNIN).supported === true;
  useEffect(() => {
    if (!autoOn || !adapter || autoStarted.current) return;
    if (
      state.phase === "loading" ||
      state.status !== "needs-activation" ||
      !identityOn
    )
      return;
    autoStarted.current = true;
    setAuto({ pending: true, seed: null });
    // The ladder and its mapping load now, with the run, not with the page.
    void import("./autoMap.js")
      .then((m) => m.runAuto(adapter, AUTO_WAIT_MS))
      .catch(() => ({ seed: null, open: false }))
      .then(({ seed, open }) => {
        if (!alive.current) return;
        setAuto({ pending: false, seed });
        if (open) setStep("signin");
      });
  }, [autoOn, adapter, state.phase, state.status, identityOn]);
  // An identity failure ends the hand-off (the Welcome step shows it).
  const identityError = state.error.identity;
  useEffect(() => {
    if (identityError && handleRef.current) {
      setHandle(null);
      setStep("home");
      pushed.current = false;
    }
  }, [identityError]);

  // "Replace a device" opened the portal: the key is tried again when the person comes back.
  const awaitingReturn = useRef(false);
  const latest = useRef({ key, adapter });
  latest.current = { key, adapter };
  useEffect(() => {
    if (typeof window === "undefined") return;
    const back = (): void => {
      if (!awaitingReturn.current || document.visibilityState === "hidden")
        return;
      awaitingReturn.current = false;
      const { key: k, adapter: a } = latest.current;
      if (a && k.trim()) void a.submitKey(k.trim()).catch(() => undefined);
    };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, []);

  const signIn = useCallback(() => {
    if (!adapter) return;
    // The kit starts its own sign-in; the refusal's `signInUrl` is only the fallback for a
    // build that cannot (license_owned, refusal.ts).
    setSignInFailed(false);
    const fallback = (e: unknown): void => {
      // Only a build that cannot sign in at all falls back to the product's sign-in page; any
      // other failure is said on the step.
      const code = (e as { code?: string } | null)?.code;
      const url = safeLink(
        (errorRef.current as { activation?: { signInUrl?: string } } | null)
          ?.activation?.signInUrl,
      );
      if (url && (code === "unsupported" || code === "service-disabled"))
        openLink(url);
      else setSignInFailed(true);
    };
    void Promise.resolve()
      .then(() => adapter.signInWithOidc())
      .then((started) => {
        // The cookie page navigates away and never gets here; a bearer page or a desktop host
        // that reports a code hands back what to show.
        if (
          started &&
          (started.userCode || safeLink(started.verificationUrl))
        ) {
          setHandle(started);
          enter("handoff", "welcome.signIn");
        }
      })
      .catch(fallback);
  }, [adapter, enter]);

  /** A key activated here: the gate shows ActivateDone with the key held in memory. */
  const keyActivated = useCallback(
    (v: string) => {
      heldKey.current = v;
      holding.current = true;
      setKey("");
      setSubmitted(false);
      setDismissed(errorRef.current);
      enter("done", "activate.submit");
    },
    [enter],
  );

  /** Start using the app (Done's primary, and "continue without an account"): the gate closes its
   *  steps and the key is dropped. */
  const finish = useCallback(() => {
    leave();
    setKey("");
    setOpener(null);
  }, [leave]);

  /** Add your name and email: with Identity on, AddToAccount; with it off, the portal. The holder
   *  flows load now, not with the gate. */
  const addToAccount = useCallback(() => {
    if (!adapter) return;
    if (!adapter.snapshot().capabilities.identity.enabled) {
      const held = heldKey.current ?? undefined;
      void import("./holderGate.js")
        .then((m) =>
          m.portalTarget(adapter, {
            ...(ctx?.baseUrl !== undefined ? { baseUrl: ctx.baseUrl } : {}),
            ...(ctx?.productSlug !== undefined
              ? { product: ctx.productSlug }
              : {}),
          }),
        )
        .then((t) => {
          if (t)
            openManage(t.url, opts.returnUrl, t.withKey ? held : undefined);
        })
        .catch(() => undefined);
      return;
    }
    if (stepRef.current === "add") return;
    dropAdd();
    addFrom.current = stepRef.current;
    const token = ++addToken.current;
    void import("./holderGate.js").then((m) => {
      if (token !== addToken.current || !alive.current) return;
      addFlow.current = m.createAddFlow(adapter, session, "device", () =>
        redrawAdd(),
      );
      holding.current = true;
      enter("add", "activate.recommend.action");
    });
  }, [adapter, ctx, opts.returnUrl, dropAdd, enter]);

  /** "Sign in to that account" on a license-owned refusal: sign in in this page and complete with
   *  the key just entered (D17). One sign-in at a time: a second press while one is live does
   *  nothing. Where the page cannot run it, the gate's own sign-in runs as before. */
  const ownedSignIn = useCallback(() => {
    if (!adapter || owning.current || session.current) return;
    owning.current = true;
    const k = key.trim();
    void import("./holderGate.js")
      .then((m) => m.ownedSignIn(adapter, session, k))
      .catch(() => "fallback" as const)
      .then((r) => {
        owning.current = false;
        if (!alive.current) return;
        if (r === "fallback") signIn();
        else if (r === "signedIn") finish();
      });
  }, [adapter, key, signIn, finish]);

  const act = useCallback(
    (k: string) => {
      if (!adapter) return;
      switch (k) {
        case "signin.key.ownedSignIn": {
          // The license is in an account already (AddToAccount's owned state): the gate's own
          // sign-in.
          if (step === "add") {
            handleRef.current?.cancel?.();
            signIn();
            return;
          }
          // Where the build cannot sign in itself, the product's sign-in page is the link.
          if (!state.capabilities.identity.enabled) {
            const url = safeLink(
              (
                state.error.license as {
                  activation?: { signInUrl?: string };
                } | null
              )?.activation?.signInUrl,
            );
            if (url) openLink(url);
            return;
          }
          handleRef.current?.cancel?.();
          ownedSignIn();
          return;
        }
        case "welcome.signIn":
          // The ladder found no account to continue with: Sign in opens the form, whose provider
          // button asks for the account chooser.
          if (auto.seed?.kind === "needsSignIn" && step === "home") {
            enter("signin", k);
            return;
          }
          handleRef.current?.cancel?.();
          signIn();
          return;
        case "signin.key.signIn":
        case "signin.again":
        case "signin.handoff.again":
        case "signInHandoff.newCode":
          handleRef.current?.cancel?.();
          signIn();
          return;
        case "welcome.useKey":
        case "signin.choice.keyInstead":
          enter("activate", k);
          return;
        case "signin.key.differentKey":
          // From a refusal: back to the key field with the refused key still in it.
          setDismissed(errorRef.current);
          setSubmitted(false);
          // A different key starts from an empty field, as the sign-in form does.
          setKey("");
          setSignInFailed(false);
          if (step === "activate") return;
          enter("activate", k);
          return;
        case "common.paste":
          void navigator.clipboard
            ?.readText()
            .then((t) => {
              setKey(t.trim());
              setSubmitted(false);
              setDismissed(errorRef.current);
            })
            .catch(() => undefined);
          return;
        case "activate.submit": {
          setSubmitted(true);
          const v = key.trim();
          if (v) {
            activating.current = true;
            void adapter
              .activateWithKey(v)
              .then((r) => {
                // After a key activation: the entries it leaves (identity on).
                const e = r.keyEntries;
                if (e)
                  setToast({
                    key: "signin.key.entriesLeftShort",
                    args: { left: Math.max(0, e.limit - e.used) },
                  });
                // No account: the license is floating, held by the key alone. ActivateDone.
                if (alive.current) keyActivated(v);
                activating.current = false;
              })
              .catch(() => {
                activating.current = false;
              });
          }
          return;
        }
        case "activate.recommend.action":
          // ActivateDone's card, and AccountAndLicense's "Not in an account" row.
          addToAccount();
          return;
        case "activate.recommend.skip":
        case "signin.done.start":
          finish();
          return;
        case "activate.waitingSignIn":
          // The license waits for its email's account: the gate's own sign-in.
          handleRef.current?.cancel?.();
          signIn();
          return;
        case "common.continue":
          if (step === "add") void addFlow.current?.model.submit();
          return;
        case "activate.otherEmail.verify":
        case "signin.auto.confirm.other":
          // A different email: back to the form with the fields kept.
          if (step === "add") void addFlow.current?.model.cancel();
          return;
        case "signin.key.addInLocker": {
          // The refusal's manage link: where the key is added to the account.
          const url = state.error.license?.manageUrl;
          if (url) openManage(url, opts.returnUrl, key.trim() || undefined);
          return;
        }
        case "deviceLimit.title":
        case "deviceLimit.primary":
        case "deviceLimit.openBrowser": {
          const url = state.error.license?.manageUrl;
          if (!url) return;
          awaitingReturn.current = true;
          openManage(url, opts.returnUrl, key.trim() || undefined);
          return;
        }
        case "signin.handoff.openBrowser": {
          const url = safeLink(handleRef.current?.verificationUrl);
          if (url) openLink(url);
          return;
        }
        case "a11y.copyCode": {
          const code = handleRef.current?.userCode;
          if (code) void navigator.clipboard?.writeText(code).catch(() => {});
          return;
        }
        case "a11y.copyAddress":
        case "signin.handoff.copyLink": {
          const h = handleRef.current;
          const url = safeLink(h?.verificationUri ?? h?.verificationUrl);
          if (url) void navigator.clipboard?.writeText(url).catch(() => {});
          return;
        }
        case "common.cancel":
        case "common.back":
          if (step === "add" && addFrom.current === "done") {
            // AddToAccount's Cancel goes back to ActivateDone, the key still held.
            dropAdd();
            setStep("done");
            return;
          }
          leave();
          return;
        case "common.tryAgain":
          if (step === "add") {
            void addFlow.current?.model.tryAgain();
            return;
          }
          void adapter.refresh({ force: true }).catch(() => undefined);
          return;
        case "common.reconnect":
          void adapter.refresh({ force: true }).catch(() => undefined);
          return;
        case "common.signOut":
          void adapter.signOut().catch(() => undefined);
          return;
      }
    },
    [
      adapter,
      key,
      signIn,
      state.error.license,
      opts.returnUrl,
      step,
      enter,
      leave,
      auto.seed,
      ownedSignIn,
      addToAccount,
      keyActivated,
      finish,
      dropAdd,
    ],
  );

  const edit = useCallback((field: string, value: string) => {
    // AddToAccount's fields are held by its model.
    if (field === "name" || field === "email") {
      addFlow.current?.model.setField(field, value);
      return;
    }
    if (field !== "key") return;
    setKey(value);
    setSubmitted(false);
    // Editing the key clears the refusal (DL7).
    setDismissed(errorRef.current);
  }, []);

  const input = useMemo(
    () =>
      ctx
        ? withSignInError(
            gateInput(state, {
              step: step === "signin" ? "home" : step,
              key,
              submitted,
              handle,
              secondsLeft,
              dismissed,
              deviceKind: "device",
              ...(addFlow.current
                ? { addToAccount: addFlow.current.model.input().addToAccount }
                : {}),
              ...(opts.locale !== undefined ? { locale: opts.locale } : {}),
            }),
            signInFailed && (step === "activate" || step === "home"),
          )
        : null,
    [
      ctx,
      state,
      step,
      key,
      submitted,
      handle,
      secondsLeft,
      dismissed,
      signInFailed,
      opts.locale,
      addState,
    ],
  );
  if (!ctx || !input) return null;
  const shown = input;
  return {
    adapter: ctx.adapter,
    // While automatic sign-in is out the gate keeps its checking screen, never a flash of Welcome.
    input:
      auto.pending && holds
        ? { ...shown, gate: { checking: true, cached: false } }
        : shown,
    step,
    seed: auto.seed,
    opener,
    act,
    edit,
    toast,
  };
}

/** The gate's input, with a sign-in that failed to start named for the refusal step. */
function withSignInError(input: UiInput, failed: boolean): UiInput {
  return failed ? { ...input, error: { code: "sign-in-failed" } } : input;
}

/** A stand-in adapter for the hooks' sake when no provider is mounted (never called). */
const INERT = {
  subscribe: () => () => {},
  snapshot: () => INERT_STATE,
} as unknown as PolarisAdapter;
const INERT_STATE = {
  phase: "loading",
  status: "needs-activation",
  error: {},
  busy: {},
} as unknown as PolarisState;
