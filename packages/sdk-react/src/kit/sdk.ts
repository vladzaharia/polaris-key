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
  useRef,
  useState,
} from "react";
import type { UiInput } from "@polaris-key/ui-core";
import {
  gateInput,
  openManage,
  type GateStep,
} from "@polaris-key/ui-core/browser";

import { PolarisContext } from "../react/context.js";
import { useAdapterState } from "../react/hooks.js";
import type { OidcSignInHandle, PolarisState } from "../core/index.js";

import { openLink, safeLink } from "./links.js";

export { gateInput, type GateStep };

/** What `<PolarisKeyGate>` needs from the SDK. */
export interface SdkGate {
  input: UiInput;
  step: GateStep;
  /** The control that opened the current step, so Back returns focus to it. */
  opener: string | null;
  act(key: string): void;
  edit(field: string, value: string): void;
}

/** The SDK-driven gate, or `null` outside `<PolarisKeyProvider>` (the gate then takes `input`). */
export function useSdkGate(
  opts: { returnUrl?: string; locale?: string } = {},
): SdkGate | null {
  const ctx = useContext(PolarisContext);
  // The hooks run whether or not a provider exists; with none they hold an inert state.
  const adapter = ctx?.adapter ?? null;
  const state = useAdapterState(adapter ?? INERT);
  const [step, setStep] = useState<GateStep>("home");
  const [key, setKey] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [handle, setHandle] = useState<OidcSignInHandle | null>(null);
  // The refusal the person left behind: leaving the step, or editing the key, clears it (DL7),
  // and the key they typed stays in the field.
  const [dismissed, setDismissed] = useState<unknown>(null);
  const [opener, setOpener] = useState<string | null>(null);
  const errorRef = useRef<unknown>(null);
  errorRef.current = state.error.license;

  // The platform's Back steps back through the gate: each step past Welcome is one history entry.
  const pushed = useRef(false);
  const skipPop = useRef(false);
  const toHome = useCallback(() => {
    handleRef.current?.cancel?.();
    setHandle(null);
    setStep("home");
    setDismissed(errorRef.current);
    setSubmitted(false);
  }, []);
  const enter = useCallback((next: GateStep, from: string) => {
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
  useEffect(() => () => handleRef.current?.cancel?.(), []);
  // A sign-in that lands, or a license that holds, ends the flow's local steps.
  useEffect(() => {
    if (state.status !== "needs-activation" && state.phase !== "loading") {
      handleRef.current?.cancel?.();
      setHandle(null);
      setStep("home");
      pushed.current = false;
    }
  }, [state.status, state.phase]);
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
    void Promise.resolve(adapter.signInWithOidc())
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
      .catch(() => undefined);
  }, [adapter, enter]);

  const act = useCallback(
    (k: string) => {
      if (!adapter) return;
      switch (k) {
        case "welcome.signIn":
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
          if (v) void adapter.submitKey(v).catch(() => undefined);
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
          leave();
          return;
        case "common.tryAgain":
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
    ],
  );

  const edit = useCallback((field: string, value: string) => {
    if (field !== "key") return;
    setKey(value);
    setSubmitted(false);
    // Editing the key clears the refusal (DL7).
    setDismissed(errorRef.current);
  }, []);

  const input = useMemo(
    () =>
      ctx
        ? gateInput(state, {
            step,
            key,
            submitted,
            handle,
            secondsLeft,
            dismissed,
            ...(opts.locale !== undefined ? { locale: opts.locale } : {}),
          })
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
      opts.locale,
    ],
  );
  if (!ctx || !input) return null;
  return {
    input,
    step,
    opener,
    act,
    edit,
  };
}

/** A stand-in adapter for the hooks' sake when no provider is mounted (never called). */
const INERT = {
  subscribe: () => () => {},
  snapshot: () => INERT_STATE,
} as unknown as import("../core/index.js").PolarisAdapter;
const INERT_STATE = {
  phase: "loading",
  status: "needs-activation",
  error: {},
  busy: {},
} as unknown as PolarisState;
