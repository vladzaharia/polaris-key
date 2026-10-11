// @pkey-feature core.store license.activate identity.devicecode
// SDK parity pass SP-N10, SP-N11 and SP-31: exposePolarisBridge (Electron main) and the preload's
// PolarisBridge v4 round-trip over a structured-clone IPC (every v3 method and verb, every v4
// verb, the v4 sign-in and activation shapes, the `release.fetch` path rule), and
// SafeStorageStore's surfaced degradation. `PolarisBridge` is imported from
// `@polaris-key/react/desktop` itself (a workspace devDependency, type-only), so if the React
// contract in `packages/sdk-react/src/desktop/bridge.ts` changes, this stops compiling instead
// of drifting.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  BridgeOidcBegin,
  BridgeState,
  PolarisBridge,
} from "@polaris-key/react/desktop";
import type { PolarisKeyClientOptions } from "../src/client.js";
import {
  DEFAULT_INVOKE_VERBS,
  exposePolarisBridge,
  POLARIS_BRIDGE_VERSION,
  SafeStorageStore,
  type ExposePolarisBridgeOptions,
} from "../src/electron/index.js";
import {
  createPreloadBridge,
  exposePolarisBridgeInMainWorld,
} from "../src/electron/renderer.js";
import { allowApp, ipcPair } from "./electronIpc.js";
import {
  json,
  seededClient,
  signedLicense,
  tempDir,
  type Handler,
} from "./parityFixtures.js";

const START = {
  deviceCode: "dc_never_leaves_main",
  userCode: "WDJB-MJHT",
  verificationUri: "https://key.plrs.im/djdl/identity/auth/device",
  verificationUriComplete:
    "https://key.plrs.im/djdl/identity/auth/device?user_code=WDJB-MJHT",
  expiresIn: 600,
  interval: 1,
};

interface SetupOptions {
  services?: string[];
  extra?: Partial<PolarisKeyClientOptions>;
  host?: Partial<ExposePolarisBridgeOptions>;
}

async function setup(
  routes: Record<string, Handler> = {},
  token: string | null = "pkeyt_seed",
  o: SetupOptions = {},
) {
  const license = await signedLicense({ pro: true });
  const seeded = await seededClient({
    license: license,
    token,
    extra: {
      expectedServices: (o.services ?? [
        "license",
        "config",
        "identity",
        "release",
      ]) as never,
      ...o.extra,
    },
    routes,
  });
  const ipc = ipcPair();
  const handle = exposePolarisBridge(seeded.client, {
    ipcMain: ipc.ipcMain,
    allowSender: allowApp,
    ...o.host,
  });
  const bridge = createPreloadBridge(ipc.ipcRenderer);
  // The load-bearing type assertion: the preload's object IS a React PolarisBridge.
  const typed: PolarisBridge = bridge;
  return { ...seeded, license, ipc, handle, bridge: typed };
}

describe("PolarisBridge v4 over IPC (SP-N10, SP-31)", () => {
  it("serves the gate state with the capability map", async () => {
    const { bridge } = await setup();
    expect(POLARIS_BRIDGE_VERSION).toBe(4);
    expect(bridge.version).toBe(4);
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
    // v4: a refusal the bridge does not name keeps its code and status (never folded into `error`).
    expect(other).toMatchObject({
      kind: "refused",
      code: "license_suspended",
      status: 403,
    });
    if (other.kind !== "refused") throw new Error("expected a refusal");
    expect(other.message).toContain("[license_suspended]");
  });

  it("keeps the device code in the main process and pushes state on ready", async () => {
    const license = await signedLicense({ pro: true });
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
        new Response(license, { status: 200 }),
      "GET /djdl/config/document": () => new Response("", { status: 404 }),
      "POST /djdl/devices/report": () => json({}),
    });
    const pushes: BridgeState[] = [];
    const off = bridge.on("stateChanged", (s) => pushes.push(s));
    const begin = await bridge.beginSignIn();
    expect(begin).toMatchObject({
      verificationUrl: START.verificationUriComplete,
      userCode: "WDJB-MJHT",
      verificationUri: START.verificationUri,
      interval: START.interval,
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

  it("passes the renderer device name and answers v4 sign-in fields", async () => {
    let body: Record<string, unknown> | null = null;
    const { bridge } = await setup(
      {
        "POST /djdl/identity/auth/device/start": (req) => {
          body = JSON.parse(req.body!) as Record<string, unknown>;
          return json(START);
        },
      },
      "pkeyt_seed",
      { host: { deviceName: "Host default" } },
    );
    const begin = (await bridge.beginSignIn({
      deviceName: "Renderer name",
    })) satisfies BridgeOidcBegin;
    expect(body).toMatchObject({ deviceName: "Renderer name" });
    expect(begin).toMatchObject({
      verificationUri: START.verificationUri,
      expiresAt: expect.any(Number),
      interval: START.interval,
    });
  });

  it("returns v4 activation kinds without folding them into error", async () => {
    const answers = [
      json({ error: { code: "fingerprint_required" } }, 403),
      json({ error: { code: "enroll_disabled" } }, 403),
      json(
        {
          error: { code: "hardware_mismatch" },
          drift: 2,
          changed: ["cpu", "board"],
        },
        403,
      ),
      json({ error: { code: "license_suspended" } }, 403),
    ];
    const { bridge } = await setup(
      { "POST /djdl/license/activate": () => answers.shift()! },
      null,
    );
    expect(await bridge.submitKey("KEY-1")).toEqual({
      kind: "fingerprint-required",
    });
    expect(await bridge.submitKey("KEY-2")).toEqual({
      kind: "enroll-disabled",
    });
    expect(await bridge.submitKey("KEY-3")).toEqual({
      kind: "hardware-mismatch",
      drift: 2,
      changed: ["cpu", "board"],
    });
    expect(await bridge.submitKey("KEY-4")).toMatchObject({
      kind: "refused",
      code: "license_suspended",
      status: 403,
    });
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

  it("refuses absolute and escaping release.fetch destinations before a request", async () => {
    const downloadDir = tempDir();
    const { bridge, seen } = await setup(
      {},
      "pkeyt_seed",
      { host: { downloadDir } },
    );
    for (const to of ["/tmp/escape.zip", "../escape.zip", "nested/../../escape.zip"]) {
      await expect(
        bridge.invoke!("release", "fetch", {
          target: { sha256: "a".repeat(64), buildId: "macos-zip" },
          to,
        }),
      ).rejects.toMatchObject({ code: "invalid-argument" });
    }
    await expect(
      bridge.invoke!("release", "fetch", {
        target: { sha256: "a".repeat(64), buildId: "macos-zip" },
        to: "C:\\escape.zip",
      }),
    ).rejects.toMatchObject({ code: "invalid-argument" });
    expect(seen).toEqual([]);
  });

  // @pkey-feature core.presentation
  it("answers the presentation verbs from the host's client (HA-13)", async () => {
    const { bridge } = await setup();
    expect(DEFAULT_INVOKE_VERBS).toContain("core.presentationIcon");
    // No discovery yet: the state carries no member, and there is no icon; never an error.
    expect(
      (await bridge.getSyncState()) as unknown as { presentation: unknown },
    ).toMatchObject({ presentation: null });
    expect(
      await bridge.invoke!("core", "presentationIcon", { px: 32, scale: 2 }),
    ).toBeNull();
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
