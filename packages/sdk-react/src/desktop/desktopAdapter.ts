// The desktop adapter: a renderer-side `PolarisAdapter` that proxies every operation to a
// `PolarisBridge` (the privileged Electron/Tauri process owning @polaris-key/node). It
// derives the gate locally from the bridge's `BridgeState` using the SHARED gateModel, so
// a desktop snapshot is byte-identical in shape to a browser snapshot (mode-parity).
//
// All credential/keyring/loopback-OIDC work lives behind the bridge; this file is pure
// glue + state projection. `submitKey` IS supported here (unlike browser): desktop apps
// allow typed-key enrollment as an offline-friendly path.

import {
  configSource,
  listUserConfig,
  projectState,
  readConfig,
  readEntitled,
} from "../core/adapter.js";
import { createStore, type Store } from "../core/store.js";
import {
  PolarisError,
  initialState,
  type ConfigSource,
  type JSONValue,
  type OidcSignInHandle,
  type PolarisAdapter,
  type PolarisState,
  type UserConfigEntry,
} from "../core/index.js";
import {
  resolveBridge,
  type BridgeState,
  type PolarisBridge,
} from "./bridge.js";

export interface DesktopAdapterOptions {
  /** The bridge to drive. Defaults to `window.polarisKey`. */
  bridge?: PolarisBridge;
  /** Override the clock (seconds) — for tests. */
  now?: () => number;
  /** Client-supplied local/user overrides for `default`-state config keys. Never override
   *  `enforced`/`hidden` keys (server wins). The node host owns env layering, not this. */
  localOverrides?: Record<string, JSONValue>;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

export class DesktopAdapter implements PolarisAdapter {
  readonly mode = "desktop" as const;
  private readonly bridge: PolarisBridge;
  private readonly store: Store<PolarisState>;
  private readonly clock: () => number;
  private readonly localOverrides: Record<string, JSONValue>;
  private offBridge: (() => void) | null = null;

  constructor(opts: DesktopAdapterOptions = {}) {
    const bridge = resolveBridge(opts.bridge);
    if (!bridge) {
      throw new PolarisError(
        "bridge-missing",
        "No PolarisBridge found. Pass { bridge } or expose window.polarisKey from your preload.",
      );
    }
    this.bridge = bridge;
    this.clock = opts.now ?? nowSec;
    this.localOverrides = opts.localOverrides ?? {};
    this.store = createStore<PolarisState>(
      initialState("desktop", this.localOverrides),
    );
    // Subscribe to pushed hot-reload signals from the privileged process.
    this.offBridge = this.bridge.on("stateChanged", (s) => this.apply(s));
    // Kick off the first load. Errors surface into the snapshot, not as a throw.
    void this.load();
  }

  snapshot(): PolarisState {
    return this.store.get();
  }

  subscribe(cb: (state: PolarisState) => void): () => void {
    return this.store.subscribe(cb);
  }

  private apply(
    s: BridgeState,
    flags: { busy?: boolean; error?: PolarisError | null } = {},
  ): void {
    this.store.set(
      projectState(
        "desktop",
        s.doc,
        {
          hasToken: s.hasToken,
          now: this.clock(),
          lastSyncUnauthorized: s.lastSyncUnauthorized,
          blocked: s.blocked,
          lastVerifiedAt: s.lastVerifiedAt,
        },
        { ...flags, localOverrides: this.localOverrides },
      ),
    );
  }

  private async load(): Promise<void> {
    try {
      this.apply(await this.bridge.getState());
    } catch (e) {
      // First load failed: present a ready, error-bearing, needs-enroll state.
      this.apply(
        { hasToken: false, doc: null },
        { error: new PolarisError("network", (e as Error).message) },
      );
    }
  }

  private setBusy(busy: boolean): void {
    this.store.set((prev) => (prev.busy === busy ? prev : { ...prev, busy }));
  }

  async refresh(): Promise<void> {
    this.setBusy(true);
    try {
      this.apply(await this.bridge.refresh());
    } catch (e) {
      const err = new PolarisError("refresh-failed", (e as Error).message);
      this.store.set((prev) => ({ ...prev, busy: false, error: err }));
      throw err;
    }
  }

  async signInWithOidc(): Promise<OidcSignInHandle | void> {
    this.setBusy(true);
    try {
      const begin = await this.bridge.beginSignIn();
      // Poll in the background; flip out of busy + apply the fresh state on completion.
      void this.pollUntilSettled(begin.flowId);
      return {
        verificationUrl: begin.verificationUrl,
        userCode: begin.userCode,
      };
    } catch (e) {
      const err = new PolarisError("sign-in-failed", (e as Error).message);
      this.store.set((prev) => ({ ...prev, busy: false, error: err }));
      throw err;
    }
  }

  private async pollUntilSettled(flowId: string): Promise<void> {
    try {
      // The bridge owns the real backoff; the renderer just re-asks until terminal.
      for (;;) {
        const r = await this.bridge.pollSignIn(flowId);
        if (r.kind === "pending") {
          await delay(1500);
          continue;
        }
        if (r.kind === "ok") {
          this.apply(await this.bridge.getState());
          return;
        }
        const err = new PolarisError(
          "sign-in-failed",
          r.kind === "error" ? r.message : r.kind,
        );
        this.store.set((prev) => ({ ...prev, busy: false, error: err }));
        return;
      }
    } catch (e) {
      const err = new PolarisError("sign-in-failed", (e as Error).message);
      this.store.set((prev) => ({ ...prev, busy: false, error: err }));
    }
  }

  async submitKey(key: string): Promise<void> {
    this.setBusy(true);
    try {
      const r = await this.bridge.submitKey(key);
      if (r.kind !== "ok") {
        const msg =
          r.kind === "machine-limit"
            ? "This license has reached its device limit."
            : r.kind === "unauthorized"
              ? "That key was not accepted."
              : r.message;
        throw new PolarisError("sign-in-failed", msg);
      }
      this.apply(await this.bridge.getState());
    } catch (e) {
      const err =
        e instanceof PolarisError
          ? e
          : new PolarisError("sign-in-failed", (e as Error).message);
      this.store.set((prev) => ({ ...prev, busy: false, error: err }));
      throw err;
    }
  }

  async signOut(): Promise<void> {
    this.setBusy(true);
    try {
      await this.bridge.signOut();
      this.apply(await this.bridge.getState());
    } catch (e) {
      const err = new PolarisError("sign-out-failed", (e as Error).message);
      this.store.set((prev) => ({ ...prev, busy: false, error: err }));
      throw err;
    }
  }

  getConfig<T = JSONValue>(key: string, fallback: T): T {
    return readConfig(this.store.get(), key, fallback);
  }

  listUserConfig(): UserConfigEntry[] {
    return listUserConfig(this.store.get());
  }

  getConfigSource(key: string): ConfigSource {
    return configSource(this.store.get(), key);
  }

  getSecret(key: string): string | null {
    // The renderer never holds secrets; resolve via the bridge's config map if mirrored.
    const v = this.store.get().config[key];
    return typeof v === "string" ? v : null;
  }

  isEntitled(name: string): boolean {
    return readEntitled(this.store.get(), name);
  }

  dispose(): void {
    this.offBridge?.();
    this.offBridge = null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Construct a desktop adapter (the canonical factory the Provider uses). */
export function desktopAdapter(
  opts: DesktopAdapterOptions = {},
): PolarisAdapter {
  return new DesktopAdapter(opts);
}
