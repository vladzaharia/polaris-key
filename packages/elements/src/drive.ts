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
import type { ComponentName, UiInput, View } from "@polaris-key/ui-core";

export { type GateConfig, type GateSnapshot, type GateStep };

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

/** The component the gate draws for its state and the sign-in step it is on. */
export function gateScreen(view: View, step: GateStep): ComponentName | null {
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
