// @pkey-feature core.store license.activate identity.devicecode
// SDK parity pass SP-N10 and SP-N11: exposePolarisBridge (Electron main) and the preload's
// PolarisBridge v3 round-trip over a structured-clone IPC, and SafeStorageStore's surfaced
// degradation. The PolarisBridge interface below is copied from
// `packages/sdk-react/src/desktop/bridge.ts` method for method (doc comments dropped, the protocol
// types inside BridgeState widened to unknown): if the React contract changes, this stops
// compiling instead of drifting.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INVOKE_VERBS,
  exposePolarisBridge,
  SafeStorageStore,
  type IpcMainLike,
} from "../src/electron/index.js";
import {
  createPreloadBridge,
  exposePolarisBridgeInMainWorld,
  type IpcRendererLike,
} from "../src/electron/renderer.js";
import {
  json,
  seededClient,
  signedLicense,
  tempDir,
  type Handler,
} from "./parityFixtures.js";

// ── The React contract (sdk-react/src/desktop/bridge.ts) ────────────────────────────────────
type BridgeState = {
  activation: unknown;
  doc: unknown;
  lastSyncUnauthorized?: boolean;
  blocked?: unknown;
  lastVerifiedAt?: number | null;
  highWaterMark?: number;
  capabilities?: unknown;
  config?: Record<string, unknown>;
};
interface BridgeOidcBegin {
  flowId: string;
  verificationUrl?: string;
  userCode?: string;
}
type BridgeOidcPoll =
  | { kind: "pending" }
  | { kind: "ok" }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "error"; message: string };
type BridgeActivation =
  | { kind: "ok" }
  | { kind: "device-limit"; limit?: number; deviceCount?: number }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string };
interface BridgeImportBundle {
  bundleId: string;
  imported: ("license" | "config")[];
}
interface PolarisBridge {
  readonly version?: number;
  getSyncState(): Promise<BridgeState>;
  refresh(): Promise<BridgeState>;
  beginSignIn(): Promise<BridgeOidcBegin>;
  pollSignIn(flowId: string): Promise<BridgeOidcPoll>;
  submitKey(key: string): Promise<BridgeActivation>;
  signOut(): Promise<void>;
  invoke?(service: string, method: string, args?: unknown): Promise<unknown>;
  fetchSchema?(): Promise<unknown>;
  importBundle?(jws: string): Promise<BridgeImportBundle>;
  on(event: "stateChanged", cb: (state: BridgeState) => void): () => void;
}

/** An in-process ipcMain/ipcRenderer pair that structured-clones every message, as Electron
 *  does, so a function or class instance in a reply fails the test. */
function ipcPair() {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const listeners = new Map<
    string,
    Set<(e: unknown, ...a: unknown[]) => void>
  >();
  const sender = {
    id: 7,
    send(channel: string, ...args: unknown[]) {
      for (const l of listeners.get(channel) ?? [])
        l({}, ...structuredClone(args));
    },
    once() {
      return undefined;
    },
  };
  let allowed = true;
  const ipcMain: IpcMainLike = {
    handle: (ch, fn) => void handlers.set(ch, fn as never),
    removeHandler: (ch) => void handlers.delete(ch),
  };
  const ipcRenderer: IpcRendererLike = {
    async invoke(ch, ...args) {
      const h = handlers.get(ch);
      if (!h) throw new Error(`No handler registered for '${ch}'`);
      const event = {
        sender,
        senderFrame: { url: allowed ? "app://main" : "https://evil.test" },
      };
      return structuredClone(await h(event, ...structuredClone(args)));
    },
    on(ch, l) {
      if (!listeners.has(ch)) listeners.set(ch, new Set());
      listeners.get(ch)!.add(l);
    },
    removeListener(ch, l) {
      listeners.get(ch)?.delete(l);
    },
  };
  return {
    ipcMain,
    ipcRenderer,
    handlers,
    deny: () => {
      allowed = false;
    },
  };
}

const START = {
  deviceCode: "dc_never_leaves_main",
  userCode: "WDJB-MJHT",
  verificationUri: "https://key.plrs.im/djdl/identity/auth/device",
  verificationUriComplete:
    "https://key.plrs.im/djdl/identity/auth/device?user_code=WDJB-MJHT",
  expiresIn: 600,
  interval: 1,
};

async function setup(
  routes: Record<string, Handler> = {},
  token: string | null = "pkeyt_seed",
) {
  const licence = await signedLicense({ pro: true });
  const seeded = await seededClient({
    license: licence,
    token,
    extra: {
      expectedServices: ["license", "config", "identity", "release"] as never,
    },
    routes,
  });
  const ipc = ipcPair();
  const handle = exposePolarisBridge(seeded.client, {
    ipcMain: ipc.ipcMain,
    allowSender: (e) => e.senderFrame?.url.startsWith("app://") === true,
  });
  const bridge = createPreloadBridge(ipc.ipcRenderer);
  // The load-bearing type assertion: the preload's object IS a React PolarisBridge.
  const typed: PolarisBridge = bridge;
  return { ...seeded, ipc, handle, bridge: typed };
}

describe("PolarisBridge v3 over IPC (SP-N10)", () => {
  it("serves the gate state with the capability map", async () => {
    const { bridge } = await setup();
    expect(bridge.version).toBe(3);
    const s = await bridge.getSyncState();
    expect(s.activation).toBe("token");
    expect((s.doc as { licenseId: string }).licenseId).toBe("lic_parity");
    expect(s.capabilities).toMatchObject({ license: { enabled: true } });
    expect(typeof s.highWaterMark).toBe("number");
  });

  it("maps activation refusals by code, never inferring device-limit", async () => {
    const answers = [
      json({ error: { code: "device_limit", limit: 2, deviceCount: 2 } }, 403),
      json({ error: { code: "license_suspended" } }, 403),
    ];
    const { bridge } = await setup(
      { "POST /djdl/license/activate": () => answers.shift()! },
      null,
    );
    expect(await bridge.submitKey("KEY-1")).toEqual({
      kind: "device-limit",
      limit: 2,
      deviceCount: 2,
    });
    const other = await bridge.submitKey("KEY-2");
    expect(other.kind).toBe("error");
    expect((other as { message: string }).message).toContain(
      "[license_suspended]",
    );
  });

  it("keeps the device code in the main process and pushes state on ready", async () => {
    const licence = await signedLicense({ pro: true });
    let ready = false;
    const { bridge } = await setup({
      "POST /djdl/identity/auth/device/start": () => json(START),
      "POST /djdl/identity/auth/device/poll": () =>
        json(
          ready
            ? { status: "ready", token: "pkeyt_signed" }
            : { status: "pending" },
        ),
      "GET /djdl/license/document": () =>
        new Response(licence, { status: 200 }),
      "GET /djdl/config/document": () => new Response("", { status: 404 }),
      "POST /djdl/devices/report": () => json({}),
    });
    const pushes: BridgeState[] = [];
    const off = bridge.on("stateChanged", (s) => pushes.push(s));
    const begin = await bridge.beginSignIn();
    expect(begin).toMatchObject({
      verificationUrl: START.verificationUriComplete,
      userCode: "WDJB-MJHT",
    });
    expect(JSON.stringify(begin)).not.toContain("dc_never_leaves_main");
    expect(await bridge.pollSignIn(begin.flowId)).toEqual({ kind: "pending" });
    ready = true;
    expect(await bridge.pollSignIn(begin.flowId)).toEqual({ kind: "ok" });
    expect(pushes.length).toBeGreaterThan(0);
    expect(await bridge.pollSignIn(begin.flowId)).toEqual({ kind: "expired" });
    expect(await bridge.pollSignIn("unknown-flow")).toEqual({
      kind: "expired",
    });
    off();
  });

  it("answers only the allowlisted invoke verbs, with the host's code on refusal", async () => {
    const { bridge } = await setup();
    expect(DEFAULT_INVOKE_VERBS).toContain("release.installUrl");
    expect(await bridge.invoke!("release", "installUrl")).toMatch(
      /install\.sh$/,
    );
    await expect(bridge.invoke!("license", "deactivate")).rejects.toMatchObject(
      { code: "invoke-not-allowed" },
    );
    await expect(bridge.importBundle!("not-a-jws")).rejects.toHaveProperty(
      "code",
    );
  });

  it("refuses a sender the host does not allow, and close() removes every handler", async () => {
    const { ipc, handle, bridge } = await setup();
    ipc.deny();
    await expect(bridge.getSyncState()).rejects.toMatchObject({
      code: "sender-refused",
    });
    handle.close();
    expect(ipc.handlers.size).toBe(0);
  });

  it("exposes the bridge in the main world under window.polarisKey", () => {
    const exposed: Record<string, unknown> = {};
    exposePolarisBridgeInMainWorld({
      contextBridge: { exposeInMainWorld: (k, v) => void (exposed[k] = v) },
      ipcRenderer: ipcPair().ipcRenderer,
    });
    expect(Object.keys(exposed)).toEqual(["polarisKey"]);
  });
});

describe("SafeStorageStore (SP-N11)", () => {
  const reversible = (available = true, backend = "gnome_libsecret") => ({
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => {
      const s = b.toString();
      if (!s.startsWith("enc:")) throw new Error("bad key");
      return s.slice(4);
    },
    getSelectedStorageBackend: () => backend,
  });

  it("encrypts the token and reports the keyring backend", async () => {
    const dir = tempDir();
    const store = new SafeStorageStore("djdl", dir, {
      safeStorage: reversible(),
      platform: "linux",
    });
    await store.setToken("pkeyt_secret");
    expect(readFileSync(join(dir, "djdl", "token.enc"), "utf8")).toBe(
      "enc:pkeyt_secret",
    );
    expect(existsSync(join(dir, "djdl", "token"))).toBe(false);
    expect(await store.getToken()).toBe("pkeyt_secret");
    expect(await store.status()).toEqual({ backend: "keyring" });
    await store.clearToken();
    expect(await store.getToken()).toBeNull();
  });

  it("surfaces every degradation instead of hiding it", async () => {
    const dir = tempDir();
    const off = new SafeStorageStore("djdl", dir, {
      safeStorage: reversible(false),
    });
    await off.setToken("pkeyt_plain");
    expect(await off.getToken()).toBe("pkeyt_plain");
    expect(await off.status()).toMatchObject({
      backend: "file",
      degraded: { reason: "keyring-unavailable" },
    });

    const basic = new SafeStorageStore("b", tempDir(), {
      safeStorage: reversible(true, "basic_text"),
      platform: "linux",
    });
    await basic.setToken("t");
    expect(await basic.status()).toMatchObject({
      degraded: { reason: "keyring-unavailable" },
    });

    // The OS key was reset: the old ciphertext no longer decrypts.
    const dir2 = tempDir();
    const a = new SafeStorageStore("c", dir2, { safeStorage: reversible() });
    await a.setToken("t");
    const reset = {
      ...reversible(),
      decryptString: () => {
        throw new Error("key changed");
      },
    };
    const b = new SafeStorageStore("c", dir2, { safeStorage: reset });
    expect(await b.getToken()).toBeNull();
    expect(await b.status()).toMatchObject({
      degraded: { reason: "keyring-error" },
    });
  });
});
