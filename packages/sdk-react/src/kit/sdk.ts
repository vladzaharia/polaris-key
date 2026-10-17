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
import type { Pending, UiInput } from "@polaris-key/ui-core";

import { PolarisContext } from "../react/context.js";
import { useAdapterState } from "../react/hooks.js";
import { isSignInRefusal } from "../core/adapter.js";
import type { OidcSignInHandle, PolarisState } from "../core/index.js";
import { withManageKey, withManageReturn } from "@polaris-key/client-core";

import type { ErrorLike } from "./errors.js";
import { openLink, safeLink } from "./links.js";

/** Which step of the one sign-in form the gate shows while activation is needed. */
export type GateStep = "home" | "activate" | "handoff";

/** What `<PolarisKeyGate>` needs from the SDK. */
export interface SdkGate {
  input: UiInput;
  step: GateStep;
  /** The control that opened the current step, so Back returns focus to it. */
  opener: string | null;
  act(key: string): void;
  edit(field: string, value: string): void;
}

/** `deviceLimit` → `device-limit` (the activation kinds are camelCase, the enum is not). */
function resultOf(kind: string): string {
  return kind.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** The refusal a license error carries for the key step, if it is one. */
function refusalOf(err: ErrorLike | null | undefined) {
  const a = err?.activation;
  if (!err || !a || a.kind === "ok") return undefined;
  return {
    result: resultOf(a.kind),
    code: a.code,
    ...(a.limit !== undefined ? { limit: a.limit } : {}),
    ...(a.deviceCount !== undefined ? { deviceCount: a.deviceCount } : {}),
    ...(err.manageUrl ? { manageUrl: err.manageUrl } : {}),
  };
}

/** Whole days left before `graceUntil` (epoch seconds), never negative. */
function daysLeft(graceUntil: number | undefined): number | undefined {
  if (graceUntil === undefined) return undefined;
  return Math.max(0, Math.ceil((graceUntil - Date.now() / 1000) / 86_400));
}

/** `graceUntil` (epoch seconds) as the date the person reads, in the kit's locale. */
function dateOf(epochSeconds: number, locale: string | undefined): string {
  const at = new Date(epochSeconds * 1000);
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(at);
  } catch {
    // A locale tag Intl does not know reads in the runtime's own.
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
      at,
    );
  }
}

/** The provider's state as the gate's models read it. */
export function gateInput(
  state: PolarisState,
  extra: {
    step: GateStep;
    key: string;
    submitted: boolean;
    handle: OidcSignInHandle | null;
    secondsLeft: number | undefined;
    /** The locale the kit speaks: the dates the models show are formatted in it. */
    locale?: string;
    /** The refusal the person already left (Back, a different key, an edit): not shown again. */
    dismissed?: unknown;
  },
): UiInput {
  const caps = state.capabilities;
  const services = (Object.keys(caps) as (keyof typeof caps)[]).filter(
    (s) => caps[s].enabled,
  );
  const failed =
    state.phase !== "loading" &&
    state.status === "needs-activation" &&
    [state.error.license, state.error.identity].some(
      (e) => e && !isSignInRefusal(e),
    );
  const pending: Pending | undefined = state.busy.license
    ? extra.step === "activate"
      ? "activate"
      : undefined
    : state.busy.identity && extra.step !== "handoff"
      ? "sign-in"
      : undefined;
  const refusal =
    extra.step === "activate" &&
    !state.busy.license &&
    state.error.license !== extra.dismissed
      ? refusalOf(state.error.license)
      : undefined;
  const range = state.gate.allowedRange;
  const input: UiInput = {
    services,
    capabilities: {
      signIn: caps.identity.enabled,
      keyEntry: caps.license.enabled,
    },
    gate:
      state.phase === "loading"
        ? { checking: true, cached: state.activation !== null }
        : {
            status: state.status,
            ...(state.status === "grace"
              ? {
                  graceDaysLeft: daysLeft(state.gate.graceUntil),
                  ...(state.gate.graceUntil !== undefined
                    ? {
                        graceDate: dateOf(state.gate.graceUntil, extra.locale),
                      }
                    : {}),
                }
              : {}),
            ...(range
              ? {
                  allowed: {
                    ...(range.min ? { min: range.min } : {}),
                    ...(range.max ? { max: range.max } : {}),
                  },
                }
              : {}),
          },
    ...(failed ? { stage: { stage: "license", outcome: "error" } } : {}),
    ...(pending ? { pending } : {}),
    keyField: { text: extra.key, submitted: extra.submitted },
    ...(refusal ? { activation: refusal } : {}),
  };
  const h = extra.handle;
  if (extra.step === "handoff" && h) {
    const address = safeLink(h.verificationUri ?? h.verificationUrl);
    input.signIn = {
      presentation: "inline",
      replace: "inline",
      channel: "device-code",
      browserOpened: true,
    };
    input.deviceCode = {
      phase:
        extra.secondsLeft !== undefined && extra.secondsLeft <= 0
          ? "expired"
          : "waiting",
      ...(extra.secondsLeft !== undefined
        ? { secondsLeft: Math.max(0, Math.ceil(extra.secondsLeft)) }
        : {}),
      ...(h.userCode ? { userCode: h.userCode } : {}),
      ...(address ? { verificationUri: address } : {}),
    };
  }
  return input;
}

/** Open the device-limit link (PX-W8): the app's return URL as `return=` and, on an `/activate`
 *  link, the typed key as the fragment `#key=`; only a link that passes `safeLink` (DL14). */
function openManage(url: string, returnUrl?: string, key?: string): void {
  let u = url;
  if (returnUrl) u = withManageReturn(u, returnUrl);
  if (key) u = withManageKey(u, key);
  const safe = safeLink(u);
  if (safe) openLink(safe);
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
