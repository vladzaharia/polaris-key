// `exposePolarisBridge` (SDK parity pass SP-N10): the Electron main process's half of the
// PolarisBridge v3 contract that `@polaris-key/react`'s desktop adapter drives. The privileged
// process owns the real client (token, keyring, cache, pinned trust); the renderer gets a proxy
// that can read state and ask for the verbs listed here, and nothing else.
//
//   main:     exposePolarisBridge(client, { ipcMain })
//   preload:  import "@polaris-key/node/electron/preload"
//   renderer: <PolarisProvider adapter={new DesktopAdapter()}> — unchanged
//
// Security: the device code of a sign-in never leaves this process (the renderer holds an opaque
// flow id), `invoke` answers only an allowlist of verbs, and a host can refuse a sender
// (`allowSender`) — for example any frame not loaded from the app's own origin.

import { randomUUID } from "node:crypto";
import type { PolarisKeyClient } from "../client.js";
import { copy } from "../core/copy.js";
import type { SignInPrompt } from "../identity/client.js";
import type { ActivationResult } from "../license/endpoints.js";
import {
  BRIDGE_METHODS,
  DEFAULT_BRIDGE_CHANNEL,
  DEFAULT_INVOKE_VERBS,
  POLARIS_BRIDGE_VERSION,
  channelOf,
  stateChannel,
  type BridgeEnvelope,
  type BridgeMethod,
} from "./protocol.js";

/** The part of Electron's `WebContents` the bridge uses. */
export interface WebContentsLike {
  readonly id: number;
  send(channel: string, ...args: unknown[]): void;
  isDestroyed?(): boolean;
  once?(event: "destroyed", listener: () => void): unknown;
}

/** The part of Electron's `IpcMainInvokeEvent` the bridge uses. */
export interface IpcMainInvokeEventLike {
  sender: WebContentsLike;
  senderFrame?: { url: string } | null;
}

/** The part of Electron's `ipcMain` the bridge uses. */
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEventLike, ...args: unknown[]) => unknown,
  ): void;
  removeHandler(channel: string): void;
}

export interface ExposePolarisBridgeOptions {
  ipcMain: IpcMainLike;
  /** Renderers that get `stateChanged` pushes without subscribing (the preload subscribes on
   *  its own, so this is only for a custom preload). */
  webContents?: WebContentsLike | WebContentsLike[];
  /** The IPC channel prefix. Default `polaris-key`; the preload must use the same. */
  channel?: string;
  /** Refuse a sender: answer `false` and every call from it resolves `sender-refused`. */
  allowSender?: (event: IpcMainInvokeEventLike) => boolean;
  /** `invoke` verbs beyond the default allowlist, as `service.method`, each with its handler. */
  invoke?: {
    extra?: Record<string, (args: unknown) => Promise<unknown> | unknown>;
  };
  /** The device name a sign-in started from this bridge reports. */
  deviceName?: string;
  /** A sign-in flow is forgotten this long after its code expired. Default 60 seconds. */
  flowGraceSeconds?: number;
}

/** What `exposePolarisBridge` returns: tear down every handler and listener. */
export type PolarisBridgeHandle = {
  close(): void;
  /** Push the current state to every subscribed renderer now. */
  pushState(): void;
};

interface FlowEntry {
  prompt: SignInPrompt;
  timer: ReturnType<typeof setTimeout>;
}

/** A BridgeState: the client's SyncState plus the capability map and the config entries. */
export function bridgeState(client: PolarisKeyClient): Record<string, unknown> {
  const state: Record<string, unknown> = {
    ...client.getSyncState(),
    capabilities: client.capabilities(),
  };
  const config = client.config.entries();
  if (config) state.config = config;
  return state;
}

/** Map `license.activateWithKey`'s outcome onto the bridge's `BridgeActivation`. Every refusal
 *  other than the three the bridge names becomes `error` with the copy catalog's sentence and
 *  the server's code (never a raw body). */
export function bridgeActivation(r: ActivationResult): Record<string, unknown> {
  switch (r.kind) {
    case "ok":
      return { kind: "ok" };
    case "device-limit": {
      const out: Record<string, unknown> = { kind: "device-limit" };
      if (r.limit !== undefined) out.limit = r.limit;
      if (r.deviceCount !== undefined) out.deviceCount = r.deviceCount;
      return out;
    }
    case "unauthorized":
      return { kind: "unauthorized" };
    default: {
      const key = r.kind === "refused" || r.kind === "error" ? r.code : r.kind;
      return {
        kind: "error",
        message: `${copy.message(key)} [${r.code}]`,
        code: r.code,
      };
    }
  }
}

function envelopeError(e: unknown): BridgeEnvelope {
  const err = e as { code?: unknown; message?: unknown; detail?: unknown };
  const out: BridgeEnvelope = {
    ok: false,
    code:
      typeof err?.code === "string" && err.code !== "" ? err.code : "unknown",
    message:
      typeof err?.message === "string" ? err.message : String(e ?? "error"),
  };
  if (typeof err?.detail === "string" || err?.detail === null)
    out.detail = err.detail as string | null;
  return out;
}

class BridgeRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function bag(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || v === "")
    throw new BridgeRefusal("invalid-arguments", `${name} must be a string.`);
  return v;
}

/**
 * Register the PolarisBridge v3 handlers on `ipcMain` for `client`. Call once, after the client
 * is created; the preload (`@polaris-key/node/electron/preload`) exposes the matching
 * `window.polarisKey`. Returns a handle whose `close()` removes every handler.
 */
export function exposePolarisBridge(
  client: PolarisKeyClient,
  opts: ExposePolarisBridgeOptions,
): PolarisBridgeHandle {
  const prefix = opts.channel ?? DEFAULT_BRIDGE_CHANNEL;
  const graceMs = (opts.flowGraceSeconds ?? 60) * 1000;
  const subscribers = new Map<number, WebContentsLike>();
  const flows = new Map<string, FlowEntry>();
  for (const wc of [opts.webContents ?? []].flat()) subscribers.set(wc.id, wc);

  const pushState = (): void => {
    if (subscribers.size === 0) return;
    const state = bridgeState(client);
    for (const [id, wc] of subscribers) {
      if (wc.isDestroyed?.()) {
        subscribers.delete(id);
        continue;
      }
      try {
        wc.send(stateChannel(prefix), state);
      } catch {
        subscribers.delete(id);
      }
    }
  };

  const onLicense = (): void => pushState();
  const onConfig = (): void => pushState();
  client.events.on("license", onLicense);
  client.events.on("config", onConfig);

  const forgetFlow = (id: string): void => {
    const f = flows.get(id);
    if (f) clearTimeout(f.timer);
    flows.delete(id);
  };

  const invokeVerbs: Record<string, (args: unknown) => Promise<unknown>> = {
    "devices.list": async () => client.listDevices(),
    "devices.rename": async (a) => {
      const b = bag(a);
      const label = b.label;
      if (label !== null && typeof label !== "string")
        throw new BridgeRefusal(
          "invalid-arguments",
          "label must be a string or null.",
        );
      await client.renameDevice(str(b.deviceId, "deviceId"), label);
      return null;
    },
    "devices.deauthorize": async (a) => {
      await client.deauthorizeDevice(str(bag(a).deviceId, "deviceId"));
      return null;
    },
    "devices.report": async () => client.devices.report(),
    "update.check": async (a) => {
      const b = bag(a);
      return client.update.check(
        typeof b.channel === "string" ? { channel: b.channel } : {},
      );
    },
    "update.decide": async (a) => {
      const b = bag(a);
      const o: Parameters<PolarisKeyClient["update"]["decide"]>[0] = {};
      if (typeof b.channel === "string") o.channel = b.channel;
      if (b.staged !== undefined)
        o.staged = b.staged as NonNullable<typeof o>["staged"];
      if (typeof b.skipVersion === "string" || b.skipVersion === null)
        o.skipVersion = b.skipVersion as string | null;
      return client.update.decide(o);
    },
    "release.changelog": async () => client.release.changelog(),
    "release.installUrl": async () => client.release.installUrl(),
    "release.downloadUrl": async (a) => {
      const b = bag(a);
      const o: { checksum?: boolean; dmg?: boolean } = {};
      if (typeof b.checksum === "boolean") o.checksum = b.checksum;
      if (typeof b.dmg === "boolean") o.dmg = b.dmg;
      return client.release.downloadUrl(
        str(b.version, "version"),
        str(b.binary, "binary"),
        str(b.arch, "arch"),
        o,
      );
    },
  };
  for (const v of DEFAULT_INVOKE_VERBS)
    if (!invokeVerbs[v]) throw new Error(`bridge verb ${v} has no handler`);
  for (const [name, fn] of Object.entries(opts.invoke?.extra ?? {}))
    invokeVerbs[name] = async (a) => fn(a);

  const handlers: Record<
    BridgeMethod,
    (event: IpcMainInvokeEventLike, ...args: unknown[]) => Promise<unknown>
  > = {
    getSyncState: async () => bridgeState(client),
    refresh: async () => {
      await client.sync({ force: true });
      return bridgeState(client);
    },
    beginSignIn: async () => {
      const prompt = await client.identity.beginSignIn(
        opts.deviceName ? { deviceName: opts.deviceName } : {},
      );
      const flowId = randomUUID();
      const ttl = Math.max(0, prompt.expiresIn * 1000) + graceMs;
      const timer = setTimeout(() => flows.delete(flowId), ttl);
      timer.unref?.();
      flows.set(flowId, { prompt, timer });
      return {
        flowId,
        verificationUrl: prompt.verificationUriComplete,
        userCode: prompt.userCode,
      };
    },
    pollSignIn: async (_e, flowId) => {
      const flow = flows.get(str(flowId, "flowId"));
      if (!flow) return { kind: "expired" };
      let r;
      try {
        r = await client.identity.pollSignIn(flow.prompt);
      } catch (e) {
        // Transport trouble says nothing about the sign-in: keep polling.
        const code = (e as { code?: unknown }).code;
        if (code === "network-error" || code === "server-error")
          return { kind: "pending" };
        throw e;
      }
      switch (r.status) {
        case "pending":
        case "slow-down":
        case "confirm":
          return { kind: "pending" };
        case "ready":
          forgetFlow(flowId as string);
          pushState();
          return { kind: "ok" };
        case "expired":
          forgetFlow(flowId as string);
          return { kind: "expired" };
        case "error":
          forgetFlow(flowId as string);
          return { kind: "error", message: r.message };
      }
    },
    submitKey: async (_e, key) => {
      const r = await client.license.activateWithKey(str(key, "key"));
      if (r.kind === "ok") pushState();
      return bridgeActivation(r);
    },
    signOut: async () => {
      await client.identity.signOut();
      pushState();
      return null;
    },
    invoke: async (_e, service, method, args) => {
      const name = `${str(service, "service")}.${str(method, "method")}`;
      const fn = Object.hasOwn(invokeVerbs, name) ? invokeVerbs[name] : null;
      if (!fn)
        throw new BridgeRefusal(
          "invoke-not-allowed",
          `This desktop host does not expose ${name} to the renderer.`,
        );
      const value = await fn(args);
      if (name === "devices.deauthorize") pushState();
      return value ?? null;
    },
    fetchSchema: async () => client.config.fetchSchema(),
    importBundle: async (_e, jws) => {
      const r = await client.importBundle(str(jws, "jws"));
      pushState();
      return r;
    },
    subscribe: async (event) => {
      const wc = event.sender;
      if (!subscribers.has(wc.id)) {
        subscribers.set(wc.id, wc);
        wc.once?.("destroyed", () => subscribers.delete(wc.id));
      }
      return { version: POLARIS_BRIDGE_VERSION };
    },
    unsubscribe: async (event) => {
      subscribers.delete(event.sender.id);
      return null;
    },
  };

  for (const method of BRIDGE_METHODS) {
    const handler = handlers[method];
    opts.ipcMain.handle(
      channelOf(prefix, method),
      async (event, ...args): Promise<BridgeEnvelope> => {
        try {
          if (opts.allowSender && !opts.allowSender(event))
            throw new BridgeRefusal(
              "sender-refused",
              "This window may not use the Polaris Key bridge.",
            );
          return { ok: true, value: await handler(event, ...args) };
        } catch (e) {
          return envelopeError(e);
        }
      },
    );
  }

  return {
    pushState,
    close() {
      for (const method of BRIDGE_METHODS)
        opts.ipcMain.removeHandler(channelOf(prefix, method));
      client.events.off("license", onLicense);
      client.events.off("config", onConfig);
      for (const id of [...flows.keys()]) forgetFlow(id);
      subscribers.clear();
    },
  };
}
