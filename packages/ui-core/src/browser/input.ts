// The gate's input: the SDK's live state mapped onto `UiInput` (UI-KITS.md §4.2, DL18). Both
// drop-ins (React's `useSdkGate`, elements' `<pk-gate config>`) read it; the models decide every
// screen and nothing here draws.

import type { AddToAccountInput, UiInput } from "../input.js";
import { activationFromOutcome } from "../errors.js";
import type { Pending } from "../vocabulary.js";
import { isSignInRefusal } from "./sdk/core/adapter.js";
import type { OidcSignInHandle, PolarisState } from "./sdk/core/index.js";
import { safeLink } from "./links.js";

/** Which step of the one sign-in form the gate shows while activation is needed. `done` and
 *  `add` follow a key that activated with no account (UK-42): ActivateDone, then AddToAccount.
 *  They show over an active license, so the gate keeps them until the person leaves them. */
export type GateStep = "home" | "activate" | "handoff" | "done" | "add";

/** The steps that belong to activation without an account. */
export function isHolderStep(step: GateStep): boolean {
  return step === "done" || step === "add";
}

/** The license's holder, read from the signed document's `profile` (UK-42, Q2): `email` empty is
 *  floating (held by the key alone), set is waiting for that email to sign in. `undefined` while
 *  no document is present, and when an account is signed in on this device (`profile.user`), so a
 *  screen never calls an account's license floating. */
export function holderOf(state: PolarisState): { email: string } | undefined {
  const p = state.profile;
  if (!p || p.user) return undefined;
  return { email: typeof p.email === "string" ? p.email : "" };
}

/** The error fields the gate needs to map a refusal to an input state. */
export interface ErrorLike {
  code?: string;
  wireCode?: string;
  manageUrl?: string;
  activation?: {
    kind: string;
    code: string;
    limit?: number;
    deviceCount?: number;
    retryAfterSeconds?: number;
    manageUrl?: string;
    signInUrl?: string;
    keyEntries?: { used: number; limit: number };
  };
}

/** `deviceLimit` → `device-limit` (the activation kinds are camelCase, the enum is not). */
function resultOf(kind: string): string {
  return kind.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** The refusal a license error carries for the key step, if it is one. */
function refusalOf(err: ErrorLike | null | undefined) {
  const a = err?.activation;
  if (!err || !a || a.kind === "ok") return undefined;
  // UK-02b D3: the SDK's typed outcomes in the views' vocabulary (the same mapping the sign-in
  // form's model applies to a thrown activation).
  if (a.kind === "keyEntryLimit" || a.kind === "licenseOwned") {
    const m = activationFromOutcome(a);
    return {
      ...m,
      ...(m.manageUrl === undefined && err.manageUrl
        ? { manageUrl: err.manageUrl }
        : {}),
    };
  }
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
    /** The device kind already worded ("computer", "browser"), for the lines that name it. */
    deviceKind?: string;
    /** AddToAccount's step, while the gate is on `add`. */
    addToAccount?: AddToAccountInput;
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
  // The holder drives ActivateDone and AccountAndLicense's floating row (UK-42).
  const holder = holderOf(state);
  if (holder) input.licenseHolder = holder;
  if (extra.step === "done" || extra.step === "add")
    input.activateDone = extra.deviceKind
      ? { deviceKind: extra.deviceKind }
      : {};
  if (extra.step === "add" && extra.addToAccount)
    input.addToAccount = extra.addToAccount;
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
