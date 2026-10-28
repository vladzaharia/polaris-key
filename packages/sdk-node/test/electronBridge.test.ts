// @pkey-feature core.store license.activate identity.devicecode
// SDK parity pass SP-N10, SP-N11 and SP-31: exposePolarisBridge (Electron main) and the preload's
// PolarisBridge v4 round-trip over a structured-clone IPC (every v3 method and verb, every v4
// verb, the v4 sign-in and activation shapes, the `release.fetch` path rule), and
// SafeStorageStore's surfaced degradation. `PolarisBridge` is imported from
// `@polaris-key/react/desktop` itself (a workspace devDependency, type-only), so if the React
// contract in `packages/sdk-react/src/desktop/bridge.ts` changes, this stops compiling instead
// of drifting.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { recordHash } from "@polaris-key/client-core";
import type {
  CrashTags,
  ReleaseFetchResult,
  UpdateEventEntry,
} from "@polaris-key/react";
import type {
  BridgeOidcBegin,
  BridgeState,
  PolarisBridge,
} from "@polaris-key/react/desktop";
import {
  PolarisKeyClient,
  type PolarisKeyClientOptions,
} from "../src/client.js";
import {
  DEFAULT_INVOKE_VERBS,
  bridgeActivation,
  exposePolarisBridge,
  POLARIS_BRIDGE_VERSION,
  SafeStorageStore,
  type ExposePolarisBridgeOptions,
} from "../src/electron/index.js";
import { channelOf, DEFAULT_BRIDGE_CHANNEL } from "../src/electron/protocol.js";
import {
  createPreloadBridge,
  exposePolarisBridgeInMainWorld,
} from "../src/electron/renderer.js";
import { allowApp, ipcPair } from "./electronIpc.js";
import {
  DEVICE,
  FixedStore,
  json,
  nowSec,
  seededClient,
  signedLicense,
  tempDir,
  type Handler,
  type Seen,
} from "./parityFixtures.js";
import {
  BASE,
  discoveryDoc,
  MemStore,
  PINS,
  PRODUCT,
  RELEASE_KEYS,
  recordPayload,
  signRecord,
  V4_SERVICES,
} from "./updateFixtures.js";

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
  routes:
    | Record<string, Handler>
    | ((license: string) => Record<string, Handler>) = {},
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
    routes: typeof routes === "function" ? routes(license) : routes,
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

  it("passes the device-limit manageUrl through", async () => {
    const manageUrl = "https://key.plrs.im/activate?next=free-device";
    const { bridge } = await setup(
      {
        "POST /djdl/license/activate": () =>
          json(
            { error: { code: "device_limit", limit: 2, deviceCount: 2 } },
            403,
          ),
      },
      null,
    );
    const r = await bridge.submitKey("KEY-1");
    expect(r.kind).toBe("device-limit");
    // The renderer's "Replace a device" link needs it: without it the refusal is a dead end.
    expect(
      bridgeActivation({
        kind: "device-limit",
        code: "device_limit",
        limit: 2,
        deviceCount: 2,
        manageUrl,
      }),
    ).toMatchObject({ manageUrl });
  });

  it("sends the key-entry kinds and keyEntries on ok (I-10a.9)", () => {
    const keyEntries = { used: 2, limit: 3 };
    expect(
      bridgeActivation({
        kind: "ok",
        token: "t",
        schemaVersion: 1,
        keyEntries,
      }),
    ).toEqual({ kind: "ok", keyEntries });
    expect(
      bridgeActivation({
        kind: "key-entry-limit",
        code: "key_entry_limit",
        keyEntries,
        manageUrl: "https://locker.example/activate",
      }),
    ).toEqual({
      kind: "key-entry-limit",
      keyEntries,
      manageUrl: "https://locker.example/activate",
    });
    expect(
      bridgeActivation({
        kind: "license-owned",
        code: "license_owned",
        signInUrl: "https://locker.example/login",
      }),
    ).toEqual({
      kind: "license-owned",
      signInUrl: "https://locker.example/login",
    });
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

  it("update.install refuses a forged store offer and never installs it", async () => {
    const { bridge, client: hostClient } = await setup();
    const client = hostClient as unknown as {
      update: {
        decide: (o?: unknown) => Promise<{ decision: unknown }>;
        install: (d: unknown) => Promise<unknown>;
      };
    };
    const installed: unknown[] = [];
    const real = {
      action: "store",
      release: { version: "2.0.0" },
      listingUrl: "https://store.example/app",
      mandatory: false,
    };
    client.update.decide = async () => ({ decision: real });
    client.update.install = async (d) => {
      installed.push(d);
      return { kind: "storeOpened", url: "https://store.example/app" };
    };
    const forged = { ...real, listingUrl: "https://evil.example/payload" };
    await expect(
      bridge.invoke!("update", "install", { decision: forged }),
    ).rejects.toMatchObject({ code: "invalid-argument" });
    expect(installed).toEqual([]);
    expect(
      await bridge.invoke!("update", "install", { decision: real }),
    ).toEqual({ kind: "storeOpened", url: "https://store.example/app" });
    expect(installed).toEqual([real]);
  });

  it("update.install re-derives under the channel the renderer last asked", async () => {
    const { bridge, client: hostClient } = await setup();
    const client = hostClient as unknown as {
      update: {
        decide: (o?: unknown) => Promise<{ decision: unknown }>;
        install: (d: unknown) => Promise<unknown>;
      };
    };
    const asked: unknown[] = [];
    const installed: unknown[] = [];
    const offer = {
      action: "binary",
      method: "direct",
      release: { version: "2.0.0" },
      build: "b2",
      mandatory: false,
      critical: false,
      prestage: [],
      discardStaged: false,
    };
    client.update.decide = async (o) => {
      asked.push(o);
      return { decision: offer };
    };
    client.update.install = async (d) => {
      installed.push(d);
      return { kind: "handedOff", version: "2.0.0" };
    };
    await bridge.invoke!("update", "decide", { channel: "beta" });
    expect(
      await bridge.invoke!("update", "install", { decision: offer }),
    ).toEqual({ kind: "handedOff", version: "2.0.0" });
    expect(asked.at(-1)).toEqual({ channel: "beta" });
    expect(installed).toEqual([offer]);
  });

  it("refuses absolute and escaping release.fetch destinations before a request", async () => {
    const downloadDir = tempDir();
    const { bridge, seen } = await setup({}, "pkeyt_seed", {
      host: { downloadDir },
    });
    for (const to of [
      "/tmp/escape.zip",
      "../escape.zip",
      "nested/../../escape.zip",
    ]) {
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

  // @pkey-feature core.presentation
  it("openExternal opens an https URL through the host's shell and nothing else (UK-06.16)", async () => {
    const opened: string[] = [];
    const { bridge, ipc } = await setup({}, "pkeyt_seed", {
      host: { shell: { openExternal: async (u) => void opened.push(u) } },
    });
    const open = bridge.openExternal!;
    expect(await open("https://polaris.locker/activate?next=free-device")).toBe(
      true,
    );
    expect(opened).toEqual([
      "https://polaris.locker/activate?next=free-device",
    ]);
    for (const bad of [
      "http://polaris.locker/",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "app://main/index.html",
      "https://user:pw@polaris.locker/",
      "not a url",
    ])
      await expect(open(bad), bad).rejects.toMatchObject({
        code: "invalid-argument",
      });
    await expect(open(42 as never)).rejects.toMatchObject({
      code: "invalid-argument",
    });
    expect(opened).toHaveLength(1);
    // The sender rule applies to it as to every other call.
    ipc.deny();
    await expect(open("https://polaris.locker/")).rejects.toMatchObject({
      code: "sender-refused",
    });
    expect(opened).toHaveLength(1);
  });

  it("openExternal without a shell answers not-configured", async () => {
    const { bridge } = await setup();
    await expect(
      bridge.openExternal!("https://polaris.locker/"),
    ).rejects.toMatchObject({ code: "not-configured" });
  });

  it("exposes the bridge in the main world under window.polarisKey", () => {
    const exposed: Record<string, unknown> = {};
    exposePolarisBridgeInMainWorld({
      contextBridge: { exposeInMainWorld: (k, v) => void (exposed[k] = v) },
      ipcRenderer: ipcPair().ipcRenderer,
    });
    expect(Object.keys(exposed)).toEqual(["polarisKey"]);
  });

  it("requires every adapter invoke pair in the v4 host allowlist", () => {
    const root = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "sdk-react",
      "src",
    );
    const calls = new Set<string>();
    // `core/presentation.ts` moved to ui-core's browser adapter (KX-EL-DRIVE); React keeps a
    // re-export shim, so the scan reads the module that holds the invoke calls.
    const uiCoreBrowser = join(
      root,
      "..",
      "..",
      "ui-core",
      "src",
      "browser",
      "sdk",
    );
    for (const file of [
      join(root, "desktop", "desktopAdapter.ts"),
      join(uiCoreBrowser, "core", "presentation.ts"),
    ]) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const expression = ts.isNonNullExpression(node.expression)
            ? node.expression.expression
            : node.expression;
          const name = ts.isPropertyAccessExpression(expression)
            ? expression.name.text
            : ts.isIdentifier(expression)
              ? expression.text
              : "";
          const offset = name === "invoke" ? 0 : name === "invokeV4" ? 2 : null;
          if (offset !== null) {
            const service = node.arguments[offset];
            const method = node.arguments[offset + 1];
            if (
              service !== undefined &&
              method !== undefined &&
              ts.isStringLiteral(service) &&
              ts.isStringLiteral(method)
            )
              calls.add(`${service.text}.${method.text}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    // I-10a.9: the adapter's `account(feature, method)` helper passes the method as a variable,
    // so the scan cannot read these three; they are the adapter's account calls.
    for (const m of ["subject", "attach", "openAccount"])
      calls.add(`identity.${m}`);
    expect([...calls].sort()).toEqual([...DEFAULT_INVOKE_VERBS].sort());
  });
});

// ── Every v4 verb, round-tripped through the real preload over structured-clone IPC and checked
//    against the result shape `packages/sdk-react/src/desktop/bridge.ts` declares ("WHAT v4 ADDS"). ──

const V4_VERBS = [
  "config.mint",
  "commerce.binding",
  "commerce.claim",
  "core.discovery",
  "core.storeStatus",
  "devices.id",
  "core.boot",
  "core.crashTags",
  "core.backendHeaders",
  "release.fetch",
  "distribution.downloadModel",
  "distribution.thisPlatform",
  "update.feedUrl",
  "config.set",
  "config.clear",
  "update.journal",
] as const;

const docRoutes = (license: string): Record<string, Handler> => ({
  "GET /djdl/license/document": () => new Response(license, { status: 200 }),
  "GET /djdl/config/document": () => new Response("", { status: 404 }),
  "POST /djdl/devices/report": () => json({}),
});

const FEEDS = {
  appcast: "https://k.test/djdl/update/appcast.xml",
  velopack:
    "https://k.test/djdl/update/{channel}/velopack/releases.{velopackChannel}.json",
};

const DISCOVERY = {
  product: "djdl",
  services: {
    license: { enabled: true },
    config: { enabled: true },
    identity: { enabled: true },
    release: { enabled: true },
    distribution: { enabled: true },
    update: { enabled: true, endpoints: FEEDS },
    commerce: { enabled: true },
  },
};

const MODEL = {
  schemaVersion: 1,
  product: { slug: "djdl", name: "DJDL" },
  channel: "stable",
  pageUrl: "https://dl.plrs.im/djdl",
  listing: {
    name: "DJDL",
    subtitle: null,
    description: null,
    developerName: null,
    website: null,
  },
  release: null,
  platforms: [
    {
      platform: "macos",
      label: "macOS",
      primary: "download:direct:macos",
      actions: ["download:direct:macos"],
      builds: [],
    },
    {
      platform: "windows",
      label: "Windows",
      primary: null,
      actions: [],
      builds: [],
    },
  ],
  actions: [
    {
      id: "download:direct:macos",
      kind: "download",
      outletId: "direct",
      platforms: ["macos"],
      label: "Download",
      url: "https://dl.plrs.im/x.dmg",
      deepLink: null,
      qr: null,
      command: null,
      fingerprint: null,
      version: "1.0.0",
      build: null,
    },
  ],
  keys: [],
};

const CATALOG = {
  schemaVersion: 1,
  entries: [
    {
      key: "ui.theme",
      kind: "config",
      category: "ui",
      schema: { type: "string", enum: ["light", "dark"] },
      managementDefault: "default",
    },
  ],
};

/** A host store that reports where it keeps the token (the shape `core.storeStatus` answers). */
class DegradedStore extends FixedStore {
  override async status() {
    return {
      backend: "file" as const,
      degraded: { reason: "keyring-unavailable" as const },
    };
  }
}

const SERVICES_ALL = [
  "license",
  "config",
  "identity",
  "release",
  "distribution",
  "update",
  "commerce",
];

interface V4Row {
  verb: (typeof V4_VERBS)[number];
  /** What this row pins, for the test name. */
  what: string;
  args?: unknown;
  routes?: (license: string) => Record<string, Handler>;
  options?: SetupOptions;
  /** The exact result shape the renderer receives (`toEqual`: no extra or missing key). */
  result?: unknown;
  /** Or the code the call rejects with. */
  rejects?: string;
  /** Checks that need the host's side effects. */
  after?: (ctx: {
    bridge: PolarisBridge;
    pushes: BridgeState[];
    result: unknown;
    seen: Seen[];
  }) => Promise<void> | void;
}

const NOW = nowSec();

const ROWS: V4Row[] = [
  {
    verb: "config.mint",
    what: "{token, expiresAt}",
    args: { recipeId: "musickit" },
    routes: () => ({
      "GET /djdl/config/mint/musickit/token": () =>
        json({ token: "minted-1", expiresAt: NOW + 600 }),
    }),
    result: { token: "minted-1", expiresAt: NOW + 600 },
  },
  {
    verb: "config.mint",
    what: "a missing recipeId rejects invalid-argument",
    args: {},
    rejects: "invalid-argument",
  },
  {
    verb: "commerce.binding",
    what: "{bindingId, products: [{store, productId, flag, deliverable}]}",
    routes: () => ({
      "GET /djdl/commerce/binding": () =>
        json({
          bindingId: "bind-1",
          products: [
            { store: "play", productId: "p1", flag: "extras.skins" },
            {
              store: "steam",
              productId: "7",
              flag: "extras.maps",
              deliverable: "dlc",
            },
          ],
        }),
    }),
    options: { services: [...SERVICES_ALL] },
    result: {
      bindingId: "bind-1",
      products: [
        {
          store: "play",
          productId: "p1",
          flag: "extras.skins",
          deliverable: "app",
        },
        {
          store: "steam",
          productId: "7",
          flag: "extras.maps",
          deliverable: "dlc",
        },
      ],
    },
  },
  {
    verb: "commerce.binding",
    what: "a refusal rejects with its code",
    routes: () => ({
      "GET /djdl/commerce/binding": () =>
        json({ error: { code: "forbidden" } }, 403),
    }),
    options: { services: [...SERVICES_ALL] },
    rejects: "forbidden",
  },
  {
    verb: "commerce.claim",
    what: "an ok claim answers the full CommerceClaimResult, then a state push",
    args: { store: "play", payload: { productId: "p1", purchaseToken: "t" } },
    routes: (license) => ({
      ...docRoutes(license),
      "POST /djdl/commerce/claim": () =>
        json({
          ok: true,
          store: "play",
          productId: "p1",
          flag: "extras.skins",
          state: "active",
          granted: true,
          changed: true,
        }),
    }),
    options: { services: [...SERVICES_ALL] },
    result: {
      kind: "ok",
      store: "play",
      productId: "p1",
      flag: "extras.skins",
      deliverable: "app",
      state: "active",
      granted: true,
      changed: true,
    },
    after: ({ pushes }) => expect(pushes.length).toBeGreaterThan(0),
  },
  {
    verb: "commerce.claim",
    what: "a not-owned claim answers notOwned{code, reason, status}",
    args: { store: "steam", payload: { ticket: "abcd", dlcAppId: 1 } },
    routes: () => ({
      "POST /djdl/commerce/claim": () =>
        json({ error: { code: "forbidden" }, reason: "not_owned" }, 403),
    }),
    options: { services: [...SERVICES_ALL] },
    result: {
      kind: "notOwned",
      code: "forbidden",
      reason: "not_owned",
      status: 403,
    },
  },
  {
    verb: "commerce.claim",
    what: "an attestation refusal answers attestationRequired{code, status}",
    args: {
      store: "app-store",
      payload: { signedTransaction: "jws.jws.jws" },
    },
    routes: () => ({
      "POST /djdl/commerce/claim": () =>
        json({ error: { code: "attestation_required" } }, 403),
    }),
    options: { services: [...SERVICES_ALL] },
    result: {
      kind: "attestationRequired",
      code: "attestation_required",
      status: 403,
    },
  },
  {
    verb: "commerce.claim",
    what: "an unknown store rejects invalid-argument",
    args: { store: "gog", payload: {} },
    rejects: "invalid-argument",
  },
  {
    verb: "commerce.claim",
    what: "a 5xx rejects with the Node code",
    args: { store: "play", payload: { productId: "p1", purchaseToken: "t" } },
    routes: () => ({
      "POST /djdl/commerce/claim": () =>
        json(
          { error: { code: "unavailable" }, reason: "store_unavailable" },
          503,
        ),
    }),
    options: { services: [...SERVICES_ALL] },
    rejects: "server-error",
  },
  {
    verb: "core.discovery",
    what: "the host's discovery document",
    routes: () => ({
      "GET /djdl/.well-known/polaris.json": () => json(DISCOVERY),
    }),
    options: { services: [...SERVICES_ALL] },
    result: expect.objectContaining({
      product: "djdl",
      services: expect.objectContaining({
        update: expect.objectContaining({ enabled: true }),
      }),
    }),
  },
  {
    verb: "core.discovery",
    what: "null when the host has none",
    result: null,
  },
  {
    verb: "core.storeStatus",
    what: "{backend, degraded?}",
    options: { extra: { store: new DegradedStore() } },
    result: {
      backend: "file",
      degraded: { reason: "keyring-unavailable" },
    },
  },
  {
    verb: "devices.id",
    what: "the host's device id, a string",
    result: DEVICE,
  },
  {
    verb: "core.boot",
    what: "{outcome, state, license, decision, emits, guard}, then a state push",
    args: {
      consent: "never",
      metered: false,
      allowOffline: true,
      allowGrace: true,
      registration: false,
      requiredPacks: [],
    },
    routes: docRoutes,
    options: { services: ["license", "config"] },
    result: {
      outcome: "ready",
      state: expect.objectContaining({ outcome: "ready" }),
      license: expect.objectContaining({ status: "ok" }),
      decision: null,
      emits: expect.arrayContaining([{ type: "boot_ready" }]),
      guard: expect.objectContaining({ result: "ok" }),
    },
    after: ({ pushes }) => expect(pushes.length).toBeGreaterThan(0),
  },
  {
    verb: "core.crashTags",
    what: 'the Sentry tags {release, environment, "pkey.outlet"}',
    args: { deliverable: "app", build: "42" },
    result: {
      release: "app@1.2.3+42",
      environment: "stable",
      "pkey.outlet": "unknown",
    } satisfies CrashTags,
  },
  {
    verb: "core.backendHeaders",
    what: "{X-PKey-License, X-PKey-Device}; with no backend.origins any origin may ask",
    args: { origin: "https://anywhere.test" },
    result: {
      "X-PKey-License": expect.any(String),
      "X-PKey-Device": expect.any(String),
    },
  },
  {
    verb: "core.backendHeaders",
    what: "an origin in backend.origins gets the headers",
    args: { origin: "https://api.test" },
    options: { extra: { backend: { origins: ["https://api.test"] } } },
    result: {
      "X-PKey-License": expect.any(String),
      "X-PKey-Device": expect.any(String),
    },
  },
  {
    verb: "core.backendHeaders",
    what: "an origin outside backend.origins, or none, rejects backend-origin-not-allowed",
    args: { origin: "https://evil.test" },
    options: { extra: { backend: { origins: ["https://api.test"] } } },
    rejects: "backend-origin-not-allowed",
  },
  {
    verb: "core.backendHeaders",
    what: "no origin named while backend.origins is set rejects the same",
    args: {},
    options: { extra: { backend: { origins: ["https://api.test"] } } },
    rejects: "backend-origin-not-allowed",
  },
  {
    verb: "distribution.downloadModel",
    what: "the download model",
    args: {},
    routes: () => ({
      "GET /djdl/distribution/download.json": () => json(MODEL),
    }),
    options: { services: [...SERVICES_ALL] },
    result: MODEL,
  },
  {
    verb: "distribution.thisPlatform",
    what: "{platform, primary, actions, builds, alsoOn}",
    args: { platform: "macos" },
    routes: () => ({
      "GET /djdl/distribution/download.json": () => json(MODEL),
    }),
    options: { services: [...SERVICES_ALL] },
    result: {
      platform: "macos",
      primary: expect.objectContaining({
        id: "download:direct:macos",
        kind: "download",
        label: "Download",
      }),
      actions: [expect.objectContaining({ kind: "download" })],
      builds: [],
      alsoOn: [{ platform: "windows", label: "Windows" }],
    },
  },
  {
    verb: "update.feedUrl",
    what: "{supported: true, url}",
    args: { kind: "appcast", channel: "stable" },
    routes: () => ({
      "GET /djdl/.well-known/polaris.json": () => json(DISCOVERY),
    }),
    options: { services: [...SERVICES_ALL] },
    result: {
      supported: true,
      url: "https://k.test/djdl/update/appcast.xml",
    },
  },
  {
    verb: "update.feedUrl",
    what: "the typed Unsupported as a result, not a rejection",
    args: { kind: "zsync" },
    routes: () => ({
      "GET /djdl/.well-known/polaris.json": () => json(DISCOVERY),
    }),
    options: { services: [...SERVICES_ALL] },
    result: expect.objectContaining({ supported: false, reason: "product" }),
  },
  {
    verb: "update.feedUrl",
    what: "an unknown kind rejects invalid-argument",
    args: { kind: "rss" },
    rejects: "invalid-argument",
  },
  {
    verb: "config.set",
    what: "null, then a state push carrying localConfig",
    args: { key: "ui.theme", value: "dark" },
    routes: () => ({ "GET /djdl/config/schema": () => json(CATALOG) }),
    result: null,
    after: async ({ bridge, pushes }) => {
      expect(pushes.at(-1)).toMatchObject({
        localConfig: { "ui.theme": "dark" },
      });
      expect(await bridge.getSyncState()).toMatchObject({
        localConfig: { "ui.theme": "dark" },
      });
    },
  },
  {
    verb: "config.set",
    what: "a value the catalog refuses keeps its bad_request code",
    args: { key: "ui.theme", value: "purple" },
    routes: () => ({ "GET /djdl/config/schema": () => json(CATALOG) }),
    rejects: "bad_request",
  },
  {
    verb: "config.clear",
    what: "null, then a state push without the key",
    args: { key: "ui.theme" },
    routes: () => ({ "GET /djdl/config/schema": () => json(CATALOG) }),
    result: null,
    after: async ({ bridge, pushes }) => {
      await bridge.invoke!("config", "set", { key: "ui.theme", value: "dark" });
      expect(pushes.at(-1)?.localConfig).toEqual({ "ui.theme": "dark" });
      await bridge.invoke!("config", "clear", { key: "ui.theme" });
      expect(pushes.at(-1)?.localConfig).toEqual({});
    },
  },
  {
    verb: "update.journal",
    what: "the journalled UpdateEventEntry",
    args: { event: "update_downloaded", release: "1.5.0", deliverable: "app" },
    result: {
      eventId: expect.any(String),
      event: "update_downloaded",
      deliverable: "app",
      release: "1.5.0",
      outlet: "unknown",
      channel: "stable",
      at: expect.any(Number),
    } satisfies UpdateEventEntry,
  },
  {
    verb: "update.journal",
    what: "null for an event the journal refuses",
    args: { event: "not_an_event", release: "1.5.0" },
    result: null,
  },
];

describe("PolarisBridge v4 verbs round-trip through the preload (SP-31)", () => {
  it("has a row for every v4 verb, each one on the host's allowlist", () => {
    for (const verb of V4_VERBS) expect(DEFAULT_INVOKE_VERBS).toContain(verb);
    const covered = new Set<string>([
      ...ROWS.map((r) => r.verb),
      "release.fetch",
    ]);
    expect([...covered].sort()).toEqual([...V4_VERBS].sort());
  });

  for (const row of ROWS) {
    it(`${row.verb}: ${row.what}`, async () => {
      const [service, method] = row.verb.split(".") as [string, string];
      const { bridge, seen } = await setup(
        row.routes ?? {},
        "pkeyt_seed",
        row.options,
      );
      const pushes: BridgeState[] = [];
      bridge.on("stateChanged", (s) => pushes.push(s));
      if (row.rejects !== undefined) {
        await expect(
          bridge.invoke!(service, method, row.args),
        ).rejects.toMatchObject({ code: row.rejects });
        return;
      }
      const result = await bridge.invoke!(service, method, row.args);
      expect(result).toEqual(row.result);
      await row.after?.({ bridge, pushes, result, seen });
    });
  }

  it("a v4 verb the host did not allowlist is refused, not answered", async () => {
    const { bridge } = await setup();
    await expect(
      bridge.invoke!("config", "rotate", { key: "x" }),
    ).rejects.toMatchObject({ code: "invoke-not-allowed" });
  });

  it("subscribe answers {version: 4}", async () => {
    const { ipc } = await setup();
    expect(
      await ipc.ipcRenderer.invoke(
        channelOf(DEFAULT_BRIDGE_CHANNEL, "subscribe"),
      ),
    ).toEqual({ ok: true, value: { version: 4 } });
  });

  it("pollSignIn's ok carries the identity the host's poll knew", async () => {
    const license = await signedLicense({ pro: true });
    const { bridge } = await setup({
      "POST /djdl/identity/auth/device/start": () => json(START),
      "POST /djdl/identity/auth/device/poll": () =>
        json({
          status: "ready",
          token: "pkeyt_signed",
          identity: { name: "Ada Lovelace", email: "ada@example.com" },
        }),
      "GET /djdl/license/document": () =>
        new Response(license, { status: 200 }),
      "GET /djdl/config/document": () => new Response("", { status: 404 }),
      "POST /djdl/devices/report": () => json({}),
    });
    const begin = await bridge.beginSignIn();
    expect(await bridge.pollSignIn(begin.flowId)).toEqual({
      kind: "ok",
      identity: { name: "Ada Lovelace", email: "ada@example.com" },
    });
  });
});

describe("release.fetch through the bridge (SP-31)", () => {
  const BYTES = Buffer.from("polaris-key build payload ".repeat(64));
  const SHA = createHash("sha256").update(BYTES).digest("hex");

  async function fetchHost(host: Partial<ExposePolarisBridgeOptions>) {
    const payload = recordPayload();
    // The fixture's declared type omits `builds`; set the one artifact this download verifies.
    const record = payload as unknown as { builds: { artifacts: unknown[] }[] };
    record.builds[0]!.artifacts = [
      { name: "app.zip", role: "payload", sha256: SHA, size: BYTES.length },
    ];
    const recordJws = await signRecord(payload);
    const hash = await recordHash(recordJws);
    const fetchImpl = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === `/${PRODUCT}/.well-known/polaris.json`)
        return new Response(JSON.stringify(discoveryDoc()), { status: 200 });
      if (path === `/${PRODUCT}/release/records/${hash}`)
        return new Response(recordJws, { status: 200 });
      if (path === `/${PRODUCT}/distribution/builds/1.5.0/macos-zip`)
        return new Response(BYTES, { status: 200 });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const store = new MemStore("dev_fetch");
    store.token = "pkeyt_fetch";
    const client = await PolarisKeyClient.create({
      productSlug: PRODUCT,
      baseUrl: BASE,
      version: "1.4.0",
      trust: { pinnedKeys: PINS },
      store,
      fetchImpl,
      requestTimeoutMs: 0,
      stateDir: tempDir(),
      expectedServices: [...V4_SERVICES] as never,
      update: {
        pinnedReleaseKeys: RELEASE_KEYS,
        outlet: "direct",
        platform: "macos",
        arch: "arm64",
      },
    });
    const ipc = ipcPair();
    exposePolarisBridge(client, {
      ipcMain: ipc.ipcMain,
      allowSender: allowApp,
      ...host,
    });
    const bridge: PolarisBridge = createPreloadBridge(ipc.ipcRenderer);
    return { bridge, hash };
  }

  const filesUnder = (dir: string): string[] =>
    (readdirSync(dir, { recursive: true }) as string[])
      .filter((p) => statSync(join(dir, p)).isFile())
      .sort();

  it("answers {path, size, sha256, version, buildId} and writes only under downloadDir", async () => {
    const downloadDir = tempDir();
    const { bridge, hash } = await fetchHost({ downloadDir });
    const pushes: BridgeState[] = [];
    bridge.on("stateChanged", (s) => pushes.push(s));
    const result = await bridge.invoke!("release", "fetch", {
      target: { sha256: hash, buildId: "macos-zip" },
      to: join("nested", "app.zip"),
    });
    expect(result).toEqual({
      path: join(downloadDir, "nested", "app.zip"),
      size: BYTES.length,
      sha256: SHA,
      version: "1.5.0",
      buildId: "macos-zip",
    } satisfies ReleaseFetchResult);
    expect(
      readFileSync(join(downloadDir, "nested", "app.zip")).equals(BYTES),
    ).toBe(true);
    // Only the verified file: no `.part`, nothing outside `nested/`.
    expect(filesUnder(downloadDir)).toEqual([join("nested", "app.zip")]);
    expect(pushes.length).toBeGreaterThan(0);
  });

  it("a host with no downloadDir writes nothing and rejects not-configured", async () => {
    const { bridge, hash } = await fetchHost({});
    await expect(
      bridge.invoke!("release", "fetch", {
        target: { sha256: hash, buildId: "macos-zip" },
        to: "app.zip",
      }),
    ).rejects.toMatchObject({ code: "not-configured" });
  });

  it("refuses a record the renderer holds: the host verifies its own", async () => {
    const downloadDir = tempDir();
    const { bridge, hash } = await fetchHost({ downloadDir });
    await expect(
      bridge.invoke!("release", "fetch", {
        target: { record: "a.b.c", sha256: hash, buildId: "macos-zip" },
        to: "app.zip",
      }),
    ).rejects.toMatchObject({ code: "invalid-argument" });
    expect(filesUnder(downloadDir)).toEqual([]);
  });

  it("an escaping destination writes nothing, inside or beside downloadDir", async () => {
    const downloadDir = tempDir();
    const { bridge, hash } = await fetchHost({ downloadDir });
    for (const to of ["../escape.zip", "nested/../../escape.zip"]) {
      await expect(
        bridge.invoke!("release", "fetch", {
          target: { sha256: hash, buildId: "macos-zip" },
          to,
        }),
      ).rejects.toMatchObject({ code: "invalid-argument" });
    }
    expect(filesUnder(downloadDir)).toEqual([]);
    expect(existsSync(join(dirname(downloadDir), "escape.zip"))).toBe(false);
  });
});

describe("host facts and update progress over the bridge (UK-06.3)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const OFFER = {
    action: "binary",
    method: "direct",
    release: { version: "2.0.0" },
    build: "b2",
    mandatory: false,
    critical: false,
    prestage: [],
    discardStaged: false,
  };

  /** A window that records what main sends it. */
  function windowAt(url: string, id: number) {
    const sent: { channel: string; payload: unknown }[] = [];
    const destroyed: (() => void)[] = [];
    return {
      sent,
      listeners: () => destroyed.length,
      destroy: () => destroyed.forEach((f) => f()),
      event: {
        sender: {
          id,
          send: (channel: string, payload: unknown) =>
            void sent.push({ channel, payload }),
          once: (_e: "destroyed", f: () => void) => void destroyed.push(f),
          removeListener: (_e: "destroyed", f: () => void) => {
            const i = destroyed.indexOf(f);
            if (i >= 0) destroyed.splice(i, 1);
          },
        },
        senderFrame: { url },
      },
    };
  }

  async function installSetup() {
    const s = await setup();
    const client = s.client as unknown as {
      update: {
        decide: (o?: unknown) => Promise<{ decision: unknown }>;
        install: (d: unknown, o?: Record<string, unknown>) => Promise<unknown>;
      };
    };
    client.update.decide = async () => ({ decision: OFFER });
    const call = (
      win: ReturnType<typeof windowAt>,
      verb = "install",
    ): Promise<{ ok: boolean; code?: string; value?: unknown }> =>
      (
        s.ipc.handlers.get(channelOf(DEFAULT_BRIDGE_CHANNEL, "invoke")) as (
          e: unknown,
          ...a: unknown[]
        ) => Promise<never>
      )(win.event, "update", verb, { decision: OFFER });
    return { ...s, client, call };
  }

  const PROGRESS = "polaris-key:updateProgress";

  it("pushes real progress to the invoking window only, and no one else", async () => {
    vi.useFakeTimers();
    const { client, call } = await installSetup();
    const mine = windowAt("app://main", 1);
    const other = windowAt("app://main", 2);
    client.update.install = async (_d, o) => {
      const on = o!.onProgress as (d: number, t: number) => void;
      on(1000, 4000);
      vi.advanceTimersByTime(150);
      on(2000, 4000);
      return { kind: "handedOff", version: "2.0.0" };
    };
    const r = await call(mine);
    expect(r).toMatchObject({ ok: true });
    expect(mine.sent).toEqual([
      {
        channel: PROGRESS,
        payload: {
          version: "2.0.0",
          done: 1000,
          total: 4000,
          phase: "download",
        },
      },
      {
        channel: PROGRESS,
        payload: {
          version: "2.0.0",
          done: 2000,
          total: 4000,
          phase: "download",
        },
      },
    ]);
    expect(other.sent).toEqual([]);
  });

  it("a refused sender is refused and gets no progress", async () => {
    const { client, call } = await installSetup();
    const evil = windowAt("https://evil.test/", 3);
    let installs = 0;
    client.update.install = async () => {
      installs++;
      return { kind: "handedOff", version: "2.0.0" };
    };
    expect(await call(evil)).toMatchObject({
      ok: false,
      code: "sender-refused",
    });
    expect(installs).toBe(0);
    expect(evil.sent).toEqual([]);
  });

  it("stops pushing to a window that left the app's origin mid-install", async () => {
    vi.useFakeTimers();
    const { client, call } = await installSetup();
    const win = windowAt("app://main", 4);
    client.update.install = async (_d, o) => {
      const on = o!.onProgress as (d: number, t: number) => void;
      on(1, 10);
      win.event.senderFrame.url = "https://evil.test/";
      vi.advanceTimersByTime(150);
      on(2, 10);
      return { kind: "handedOff", version: "2.0.0" };
    };
    await call(win);
    expect(win.sent).toHaveLength(1);
  });

  it("invents no percentage: an unknown or inconsistent total is null", async () => {
    vi.useFakeTimers();
    const { client, call } = await installSetup();
    const win = windowAt("app://main", 5);
    client.update.install = async (_d, o) => {
      const on = o!.onProgress as (d: number, t: number) => void;
      for (const [d, t] of [
        [10, 0],
        [20, Number.NaN],
        [30, 25],
        [-1, 100],
      ] as const) {
        on(d, t);
        vi.advanceTimersByTime(150);
      }
      return { kind: "handedOff", version: "2.0.0" };
    };
    await call(win);
    expect(win.sent.map((m) => m.payload)).toEqual([
      expect.objectContaining({ done: 10, total: null }),
      expect.objectContaining({ done: 20, total: null }),
      expect.objectContaining({ done: 30, total: null }),
    ]);
  });

  it("throttles to 10 per second", async () => {
    vi.useFakeTimers();
    const { client, call } = await installSetup();
    const win = windowAt("app://main", 6);
    client.update.install = async (_d, o) => {
      const on = o!.onProgress as (d: number, t: number) => void;
      for (let i = 1; i <= 100; i++) {
        on(i, 100);
        vi.advanceTimersByTime(10); // 100 events over one second
      }
      return { kind: "handedOff", version: "2.0.0" };
    };
    await call(win);
    // Ten leading pushes in the second, then the held final one when the install completes.
    expect(win.sent.length).toBeGreaterThanOrEqual(10);
    expect(win.sent.length).toBeLessThanOrEqual(11);
    expect(win.sent.at(-1)!.payload).toMatchObject({ done: 100, total: 100 });
  });

  it("a throttled final event is flushed on success, never after a failure or a cancel", async () => {
    vi.useFakeTimers();
    const { client, call } = await installSetup();
    const ok = windowAt("app://main", 20);
    client.update.install = async (_d, o) => {
      const on = o!.onProgress as (d: number, t: number) => void;
      on(10, 100);
      on(100, 100); // inside the 100 ms window: held back
      return { kind: "handedOff", version: "2.0.0" };
    };
    await call(ok);
    expect(ok.sent.map((m) => (m.payload as { done: number }).done)).toEqual([
      10, 100,
    ]);
    expect(ok.listeners()).toBe(0); // the destroyed listener is gone

    const failed = windowAt("app://main", 21);
    client.update.install = async (_d, o) => {
      const on = o!.onProgress as (d: number, t: number) => void;
      on(10, 100);
      on(100, 100);
      throw new Error("verify failed");
    };
    expect(await call(failed)).toMatchObject({ ok: false });
    expect(failed.sent).toHaveLength(1);
    expect(failed.listeners()).toBe(0);

    const cancelled = windowAt("app://main", 22);
    client.update.install = async (_d, o) => {
      const on = o!.onProgress as (d: number, t: number) => void;
      on(10, 100);
      on(100, 100);
      cancelled.destroy();
      return { kind: "handedOff", version: "2.0.0" };
    };
    await call(cancelled);
    expect(cancelled.sent).toHaveLength(1);
  });

  it("pushes nothing after an error, a late callback, or the window closing", async () => {
    vi.useFakeTimers();
    const { client, call } = await installSetup();
    const failed = windowAt("app://main", 7);
    let late!: (d: number, t: number) => void;
    client.update.install = async (_d, o) => {
      late = o!.onProgress as typeof late;
      late(1, 10);
      throw new Error("download failed");
    };
    expect(await call(failed)).toMatchObject({ ok: false });
    vi.advanceTimersByTime(500);
    late(5, 10);
    expect(failed.sent).toHaveLength(1);

    const cancelled = windowAt("app://main", 8);
    let signal!: AbortSignal;
    client.update.install = async (_d, o) => {
      signal = o!.signal as AbortSignal;
      const on = o!.onProgress as (d: number, t: number) => void;
      cancelled.destroy();
      vi.advanceTimersByTime(500);
      on(9, 10);
      return { kind: "handedOff", version: "2.0.0" };
    };
    await call(cancelled);
    expect(signal.aborted).toBe(true);
    expect(cancelled.sent).toEqual([]);
  });

  it("the preload delivers progress and unsubscribes", async () => {
    const ipc = ipcPair();
    const bridge = createPreloadBridge(ipc.ipcRenderer);
    const typed: PolarisBridge = bridge;
    const got: unknown[] = [];
    const off = typed.onUpdateProgress!((p) => got.push(p));
    ipc.sender.send(PROGRESS, {
      done: 3,
      total: 9,
      version: "2.0.0",
      phase: "download",
      leaked: "dropped",
    });
    ipc.sender.send(PROGRESS, { done: "many" });
    expect(got).toEqual([
      { done: 3, total: 9, version: "2.0.0", phase: "download" },
    ]);
    off();
    ipc.sender.send(PROGRESS, { done: 4, total: 9 });
    expect(got).toHaveLength(1);
  });

  it("maps the host's OS and the injected Electron facts into state.host", async () => {
    const real = process.platform;
    try {
      for (const [platform, os] of [
        ["darwin", "macos"],
        ["win32", "windows"],
        ["linux", "linux"],
      ] as const) {
        Object.defineProperty(process, "platform", { value: platform });
        const { bridge } = await setup({}, "pkeyt_seed", {
          host: {
            electron: {
              systemPreferences: { getAccentColor: () => "FF8800FF" },
              nativeTheme: {
                shouldUseHighContrastColors: true,
                prefersReducedTransparency: false,
              },
            },
          },
        });
        expect((await bridge.getSyncState()).host).toEqual({
          os,
          accentColor: "#ff8800",
          highContrast: true,
          reducedTransparency: false,
        });
      }
      // Without the option, or with a throwing accessor, only what is known.
      Object.defineProperty(process, "platform", { value: "linux" });
      const bare = await setup();
      expect((await bare.bridge.getSyncState()).host).toEqual({ os: "linux" });
      const throwing = await setup({}, "pkeyt_seed", {
        host: {
          electron: {
            systemPreferences: {
              getAccentColor: () => {
                throw new Error("no accent");
              },
            },
          },
        },
      });
      expect((await throwing.bridge.getSyncState()).host).toEqual({
        os: "linux",
      });
    } finally {
      Object.defineProperty(process, "platform", { value: real });
    }
  });
});

describe("menu items and open(view) (UK-06.4)", () => {
  const OPEN = "polaris-key:open";

  it("labels follow the platform and the locale: title case only on macOS, English only", async () => {
    const { handle } = await setup();
    const labels = (o?: { platform?: string; locale?: string }) =>
      handle.menuItems(o).map((m) => m.label);
    expect(labels({ platform: "linux" })).toEqual([
      "Check for updates",
      "Manage license",
    ]);
    expect(labels({ platform: "win32" })).toEqual(
      labels({ platform: "linux" }),
    );
    expect(labels({ platform: "darwin" })).toEqual([
      "Check for Updates…",
      "Manage License…",
    ]);
    expect(labels({ platform: "macos", locale: "en-US" })).toEqual(
      labels({ platform: "darwin" }),
    );
    // Another locale keeps its own sentence on macOS too.
    expect(labels({ platform: "darwin", locale: "de" })).toEqual([
      "Nach Updates suchen",
      "Lizenz verwalten",
    ]);
    expect(labels({ platform: "linux", locale: "pt-BR" })[1]).toBe(
      "Gerenciar a licença",
    );
    // Every launch locale has both labels, none an untranslated placeholder.
    for (const locale of [
      "en",
      "de",
      "fr",
      "es",
      "pt-BR",
      "it",
      "ja",
      "ko",
      "zh-Hans",
    ])
      for (const label of labels({ locale })) {
        expect(label).not.toBe("");
        expect(label).not.toMatch(/[{}]|menu\./);
      }
    expect(handle.menuItems().map((m) => m.id)).toEqual([
      "polaris-key.checkForUpdates",
      "polaris-key.manageLicense",
    ]);
    // Plain objects (Electron's MenuItemConstructorOptions takes them as they are).
    for (const m of handle.menuItems())
      expect(Object.keys(m).sort()).toEqual(["click", "id", "label"]);
  });

  it("a click pushes open to the subscribed windows only", async () => {
    const ipc = ipcPair();
    const { client } = await setup();
    const handle = exposePolarisBridge(client, {
      ipcMain: ipc.ipcMain,
      allowSender: allowApp,
      channel: "polaris-key",
    });
    const bridge = createPreloadBridge(ipc.ipcRenderer);
    const typed: PolarisBridge = bridge;
    const seen: string[] = [];
    const [update, settings] = handle.menuItems();
    update!.click(); // nobody subscribed yet
    const off = typed.onOpen!((v) => seen.push(v));
    await new Promise((r) => setTimeout(r, 0)); // the preload's subscribe call lands
    update!.click();
    settings!.click();
    expect(seen).toEqual(["update", "settings"]);
    off();
    await new Promise((r) => setTimeout(r, 0));
    settings!.click();
    expect(seen).toEqual(["update", "settings"]);
    handle.close();
  });

  it("refuses an unknown view, and the preload drops one it does not know", async () => {
    const { handle, ipc, bridge } = await setup();
    expect(() => handle.open("admin" as never)).toThrow(/not a view/);
    const seen: string[] = [];
    (bridge as PolarisBridge).onOpen!((v) => seen.push(v));
    ipc.sender.send(OPEN, "admin");
    ipc.sender.send(OPEN, { view: "settings" });
    ipc.sender.send(OPEN, "settings");
    expect(seen).toEqual(["settings"]);
  });

  it("a window that navigated off the app after subscribing gets no state push", async () => {
    const { handle, ipc, bridge } = await setup();
    const states: unknown[] = [];
    bridge.on("stateChanged", (s) => states.push(s));
    await new Promise((r) => setTimeout(r, 0));
    handle.pushState();
    expect(states).toHaveLength(1);
    ipc.sender.mainFrame.url = "https://evil.test/";
    handle.pushState();
    expect(states).toHaveLength(1);
  });

  it("a window that navigated off the app after subscribing gets no open", async () => {
    const { handle, ipc, bridge } = await setup();
    const seen: string[] = [];
    (bridge as PolarisBridge).onOpen!((v) => seen.push(v));
    await new Promise((r) => setTimeout(r, 0));
    handle.open("settings");
    expect(seen).toEqual(["settings"]);
    ipc.sender.mainFrame.url = "https://evil.test/";
    handle.open("update");
    expect(seen).toEqual(["settings"]);
    // A window that reports no frame at all is not pushed to either.
    ipc.sender.mainFrame = undefined as never;
    handle.open("update");
    expect(seen).toEqual(["settings"]);
  });

  it("a destroyed window is dropped and the others still get the push", async () => {
    const sent: unknown[] = [];
    const live = {
      id: 1,
      mainFrame: { url: "app://main" },
      send: (_c: string, v: unknown) => void sent.push(v),
    };
    const dead = {
      id: 2,
      send: () => {
        throw new Error("gone");
      },
      isDestroyed: () => true,
    };
    const { handle } = await setup({}, "pkeyt_seed", {
      host: { webContents: [dead, live] },
    });
    handle.open("settings");
    expect(sent).toEqual(["settings"]);
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
