// The SDK half of `<pk-gate config>` (UI-KITS.md §4.2, DL18): the `config` attribute builds the
// browser client and a `GateDriver` over it (both from `@polaris-key/ui-core/browser`, the same
// module React's `useSdkGate` uses), and this file maps the driver onto the element: the input
// the models read, the screen a step calls for and the controls the host answers. Nothing here
// draws and nothing here imports React.

import {
  createBrowserClient,
  GateDriver,
  parseGateConfig,
  PolarisError,
  type BrowserClientSeams,
  type GateConfig,
  type GateSnapshot,
  type GateStep,
  type PolarisAdapter,
} from "@polaris-key/ui-core/browser";
import type {
  AutoOutcome,
  AddIn,
  ScreenName,
  SignInPrimitives,
  UiInput,
  View,
} from "@polaris-key/ui-core";

import { AUTO_WAIT_MS, autoSupported, primitivesOf, runAuto } from "./auto.js";

export { type GateConfig, type GateSnapshot, type GateStep };

/** The steps that follow a key with no account: ActivateDone and AddToAccount. */
export function isHolderStep(step: GateStep): boolean {
  return step === "done" || step === "add";
}

/** What the host can act on itself (lead decision 7): each is drawn only when the host says it
 *  answers it, in `handles` (`handles="trial restore continue-free renew"`). */
export const HOST_ACTIONS = ["trial", "restore", "continue-free", "renew"];

/** The host actions a `handles` attribute names; unknown names are ignored. */
export function parseHandles(value: string | null | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => HOST_ACTIONS.includes(s)),
  );
}

/** The input the gate's models read: the SDK's, with the host-dependent actions the host answers. */
export function drivenInput(
  snapshot: GateSnapshot,
  handles: ReadonlySet<string>,
): UiInput {
  const input = snapshot.input;
  return {
    ...input,
    capabilities: {
      ...input.capabilities,
      ...(handles.has("trial") ? { trial: true } : {}),
      ...(handles.has("restore") ? { restore: true } : {}),
      ...(handles.has("continue-free") ? { enroll: true } : {}),
    },
    // Renew draws when the host answers it: `renew: {}` hands the press to the host.
    ...(handles.has("renew") ? { renew: {} } : {}),
  };
}

/** The component the gate draws for its state and the sign-in step it is on. The steps after a
 *  key with no account (UK-42) show over any state: the license is active, so they hold the
 *  window until the person leaves them (ActivateDone, then AddToAccount). */
export function gateScreen(view: View, step: GateStep): ScreenName | null {
  if (step === "done") return "ActivateDone";
  if (step === "add") return "AddToAccount";
  switch (view.state) {
    case "grace":
      return "GraceBanner";
    case "needs-activation":
      return step === "activate"
        ? "Activate"
        : step === "handoff"
          ? "SignInHandoff"
          : "Welcome";
    case "blocked":
      return step === "activate" ? "Activate" : "StatusScreen";
    default:
      return null;
  }
}

/** Test and embedding seams: a client built elsewhere, or the fetch / navigation it uses. */
export interface GateSeams extends BrowserClientSeams {
  client?: PolarisAdapter;
  /** Where Add your name and email goes; absent, the web switch (`WEB_ADD_IN`: the portal). */
  addIn?: AddIn;
}

/** The invalid-config failure the element reports as `pk-error`. */
export interface GateConfigError {
  code: string;
  message: string;
}

/**
 * One driven gate: the client and driver for the current `config`, rebuilt when the config's
 * value changes. `sync` is idempotent and cheap, so the element calls it on every update.
 */
export class GateBinding {
  driver: GateDriver | null = null;
  error: GateConfigError | null = null;
  private key: string | null = null;
  private unsub: (() => void) | null = null;
  private attached = false;
  private seamsRef: GateSeams | undefined;
  private readonly onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  /** Make the driver match `config` (a JSON string or object) and the seams. */
  sync(
    config: unknown,
    seams: GateSeams | undefined,
    locale: string | undefined,
  ): void {
    const next =
      config === undefined || config === null || config === ""
        ? null
        : typeof config === "string"
          ? config
          : JSON.stringify(config);
    if (next === this.key && seams === this.seamsRef) {
      this.driver?.setLocale(locale);
      return;
    }
    this.stop();
    this.key = next;
    this.seamsRef = seams;
    this.error = null;
    if (next === null) return;
    let parsed: GateConfig;
    try {
      parsed = parseGateConfig(next);
    } catch (e) {
      this.error =
        e instanceof PolarisError
          ? { code: e.code, message: e.message }
          : { code: "invalid-options", message: String(e) };
      return;
    }
    let adapter: PolarisAdapter;
    try {
      adapter = seams?.client ?? createBrowserClient(parsed, seams);
    } catch (e) {
      this.error = {
        code: (e as { code?: string }).code ?? "invalid-options",
        message: (e as Error).message,
      };
      return;
    }
    this.driver = new GateDriver(adapter, {
      ...(parsed.returnUrl ? { returnUrl: parsed.returnUrl } : {}),
      ...(parsed.version ? { version: parsed.version } : {}),
      product: parsed.product,
      // The control-plane origin: the one place the held key may go (the portal link's origin
      // is checked against it), and the product page's fallback.
      ...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
      // A page is a browser: the lines that name this device say so.
      deviceKind: "browser",
      ...(seams?.addIn ? { addIn: seams.addIn } : {}),
      ...(locale ? { locale } : {}),
    });
    this.unsub = this.driver.subscribe(this.onChange);
    if (this.attached) this.driver.attach();
  }

  /** The element joined a document: start the client. */
  attach(): void {
    this.attached = true;
    this.driver?.attach();
  }

  /** The element left it: the client stops a tick later unless it comes back. */
  detach(): void {
    this.attached = false;
    this.driver?.detach();
  }

  private stop(): void {
    this.unsub?.();
    this.unsub = null;
    this.driver?.detach();
    this.driver = null;
  }

  dispose(): void {
    this.stop();
    this.attached = false;
  }
}

/**
 * Automatic sign-in for one driven gate (I-46.9): the ladder once at boot, when the page needs a
 * sign-in and the product can sign in; what it found (`seed`) steps the gate into the in-app form
 * (a confirm, the license list, the device limit). `enabled` is false for `auto-sign-in="off"`:
 * no ladder, no hold, Welcome as before. A sign-in that landed moves the license state by itself.
 */
export class AutoSignInRun {
  /** The one run at boot is out: the gate keeps its checking screen, never a flash of Welcome. */
  pending = false;
  /** What the ladder found, for the form to show first (null: the methods). */
  seed: AutoOutcome | null = null;
  /** The gate draws the in-app form instead of its screens. */
  formOpen = false;
  private adapter: PolarisAdapter | null = null;
  private started = false;
  private alive = true;
  private prims: SignInPrimitives | null = null;
  private readonly onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  /** Follow the gate's driver: a new client starts over. */
  follow(driver: GateDriver | null): void {
    const adapter = driver?.adapter ?? null;
    if (adapter === this.adapter) return;
    this.adapter = adapter;
    this.started = false;
    this.pending = false;
    this.seed = null;
    this.formOpen = false;
    this.prims = null;
  }

  stop(): void {
    this.alive = false;
  }

  start(): void {
    this.alive = true;
  }

  /** The ladder holds the checking screen only where the build has one to run. */
  holds(enabled: boolean): boolean {
    return (
      enabled &&
      this.pending &&
      this.adapter !== null &&
      autoSupported(this.adapter)
    );
  }

  /** Called on every update: run the ladder once, when the first answer says it is needed. */
  tick(enabled: boolean): void {
    const a = this.adapter;
    if (!enabled || !a || this.started || typeof a.autoSignIn !== "function")
      return;
    const state = a.snapshot();
    if (
      state.phase === "loading" ||
      state.status !== "needs-activation" ||
      state.capabilities?.identity.enabled !== true
    )
      return;
    this.started = true;
    this.pending = true;
    void runAuto(a, AUTO_WAIT_MS)
      .catch(() => ({ seed: null, open: false }))
      .then(({ seed, open }) => {
        if (!this.alive || this.adapter !== a) return;
        this.pending = false;
        this.seed = seed;
        this.formOpen = open;
        this.onChange();
      });
  }

  /** Welcome's Sign in: the ladder found no account to continue with, so the form opens with the
   *  provider's button. True when it did. */
  openMethods(): boolean {
    if (this.seed?.kind !== "needsSignIn" || this.formOpen) return false;
    this.formOpen = true;
    this.onChange();
    return true;
  }

  /** The person left the form for Welcome (or the gate's own sign-in): what it held is spent. */
  close(): void {
    if (!this.formOpen) return;
    this.formOpen = false;
    this.seed = this.seed ? { kind: "needsSignIn" } : null;
    this.onChange();
  }

  /** The form's primitives: the SDK's calls, with `leave` for the gate's own sign-in. */
  primitives(leave: () => void): SignInPrimitives | null {
    const a = this.adapter;
    if (!a) return null;
    this.prims ??= primitivesOf(
      a,
      () => {
        this.close();
        leave();
      },
      () => this.seed?.kind === "confirm" && this.seed.input.license === "new",
    );
    return this.prims;
  }
}
