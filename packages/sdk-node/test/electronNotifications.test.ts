// @pkey-feature core.store identity.devicecode update.driver
// UK-06.5: opt-in OS notifications from exposePolarisBridge. Two events only (an update ready to
// restart, a sign-in finished), each only while the app is not focused, with static catalog text.

import { describe, expect, it } from "vitest";
import type { PolarisBridge } from "@polaris-key/react/desktop";
import { exposePolarisBridge } from "../src/electron/index.js";
import { KIT_COPY, KIT_COPY_LOCALES } from "../src/kitCopy.generated.js";
import { createPreloadBridge } from "../src/electron/renderer.js";
import { allowApp, ipcPair } from "./electronIpc.js";
import { json, seededClient, signedLicense } from "./parityFixtures.js";
import type { BridgeNotifications } from "../src/electron/main.js";

const START = {
  deviceCode: "dc_never_leaves_main",
  userCode: "WDJB-MJHT",
  verificationUri: "https://key.plrs.im/djdl/identity/auth/device",
  verificationUriComplete:
    "https://key.plrs.im/djdl/identity/auth/device?user_code=WDJB-MJHT",
  expiresIn: 600,
  interval: 1,
};

/** Everything a notification must never carry, from the fixture state. */
const SECRETS = [
  "dc_never_leaves_main",
  "WDJB-MJHT",
  "pkeyt_signed",
  "pkeyt_seed",
  "pkey_djdl_LICENSEKEY",
  "ada@example.com",
  "Ada",
  "lic_parity",
  "djdl",
  "device_limit",
  "license_suspended",
];

class FakeNotification {
  static shown: FakeNotification[] = [];
  static supported = true;
  static isSupported() {
    return FakeNotification.supported;
  }
  private click: (() => void) | null = null;
  constructor(readonly options: { title: string; body: string }) {}
  on(event: string, l: () => void) {
    if (event === "click") this.click = l;
  }
  show() {
    FakeNotification.shown.push(this);
  }
  press() {
    this.click?.();
  }
}

async function setup(
  notifications: BridgeNotifications | undefined,
  decideAndInstall = false,
) {
  FakeNotification.shown = [];
  FakeNotification.supported = true;
  const license = await signedLicense({ pro: true });
  const seeded = await seededClient({
    license,
    token: "pkeyt_seed",
    extra: {
      expectedServices: ["license", "config", "identity", "release"] as never,
    },
    routes: {
      "GET /djdl/.well-known/polaris.json": () =>
        json({
          product: "djdl",
          services: {
            identity: {
              enabled: true,
              configured: true,
              endpoints: { signout: "https://k.test/djdl/identity/signout" },
            },
          },
        }),
      "POST /djdl/identity/signout": () => json({ released: true }),
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
    },
  });
  const ipc = ipcPair();
  const handle = exposePolarisBridge(seeded.client, {
    ipcMain: ipc.ipcMain,
    allowSender: allowApp,
    ...(notifications ? { notifications } : {}),
  });
  const bridge: PolarisBridge = createPreloadBridge(ipc.ipcRenderer);
  const offer = {
    action: "binary",
    method: "direct",
    release: { version: "9.9.9-lic_parity" },
    build: "b9",
    mandatory: false,
    critical: false,
    prestage: [],
    discardStaged: false,
  };
  const client = seeded.client as unknown as {
    update: {
      decide: () => Promise<{ decision: unknown }>;
      install: () => Promise<unknown>;
    };
  };
  if (decideAndInstall) {
    client.update.decide = async () => ({ decision: offer });
    client.update.install = async () => ({
      kind: "restartRequired",
      version: "9.9.9-lic_parity",
      restart: async () => undefined,
    });
  }
  return { handle, bridge, offer, client };
}

const opts = (
  over: Partial<BridgeNotifications> = {},
): BridgeNotifications => ({
  Notification: FakeNotification as never,
  isAppFocused: () => false,
  ...over,
});

const signIn = async (b: Awaited<ReturnType<typeof setup>>["bridge"]) => {
  const begin = await b.beginSignIn();
  return b.pollSignIn(begin.flowId);
};
const install = async (s: Awaited<ReturnType<typeof setup>>) => {
  await s.bridge.invoke!("update", "decide", {});
  return s.bridge.invoke!("update", "install", { decision: s.offer });
};

describe("OS notifications (UK-06.5)", () => {
  it("shows nothing without the option", async () => {
    const s = await setup(undefined, true);
    await install(s);
    await signIn(s.bridge);
    expect(FakeNotification.shown).toEqual([]);
  });

  it("an update ready to restart notifies while unfocused, with the catalog text", async () => {
    const s = await setup(opts(), true);
    expect(await install(s)).toMatchObject({ kind: "restartRequired" });
    expect(FakeNotification.shown).toHaveLength(1);
    expect(FakeNotification.shown[0]!.options).toEqual({
      title: KIT_COPY.en["notify.updateReady.title"],
      body: KIT_COPY.en["notify.updateReady.body"],
    });
  });

  it("a finished sign-in notifies while unfocused, with the catalog text", async () => {
    const s = await setup(opts());
    expect(await signIn(s.bridge)).toMatchObject({ kind: "ok" });
    expect(FakeNotification.shown).toHaveLength(1);
    expect(FakeNotification.shown[0]!.options).toEqual({
      title: KIT_COPY.en["notify.signedIn.title"],
      body: KIT_COPY.en["notify.signedIn.body"],
    });
  });

  it("nothing while the app is focused, and an unsupported platform shows none", async () => {
    const focused = await setup(opts({ isAppFocused: () => true }), true);
    await install(focused);
    await signIn(focused.bridge);
    expect(FakeNotification.shown).toEqual([]);
    const s = await setup(opts(), true);
    FakeNotification.supported = false;
    await install(s);
    expect(FakeNotification.shown).toEqual([]);
  });

  it("only those two events notify: a pending poll, a refused install, other verbs", async () => {
    const s = await setup(opts(), true);
    (s.client.update as { install: unknown }).install = async () => ({
      kind: "unsupported",
      reason: "dependency",
      detail: "no driver",
    });
    await install(s);
    await s.bridge.invoke!("update", "check", {}).catch(() => undefined);
    await s.bridge.getSyncState();
    await s.bridge.signOut();
    expect(FakeNotification.shown).toEqual([]);
  });

  it("no key, code, email or licence id in any text, in any locale", async () => {
    for (const locale of KIT_COPY_LOCALES) {
      const s = await setup(opts({ locale }), true);
      await install(s);
      await signIn(s.bridge);
      expect(FakeNotification.shown).toHaveLength(2);
      for (const n of FakeNotification.shown) {
        const text = `${n.options.title}\n${n.options.body}`;
        for (const secret of SECRETS) expect(text).not.toContain(secret);
        expect(text).not.toMatch(/pkey[a-z]*_|@|lic_|\{|\}|notify\./);
        expect(n.options.title).not.toBe("");
        expect(n.options.body).not.toBe("");
      }
    }
  });

  it("a click runs onClick (focus the window) and a throwing handler is harmless", async () => {
    let focused = 0;
    const s = await setup(opts({ onClick: () => void focused++ }));
    await signIn(s.bridge);
    FakeNotification.shown[0]!.press();
    expect(focused).toBe(1);
    const t = await setup(
      opts({
        onClick: () => {
          throw new Error("no window");
        },
      }),
    );
    await signIn(t.bridge);
    expect(() => FakeNotification.shown[0]!.press()).not.toThrow();
  });

  it("a failing Notification never fails the sign-in or the install", async () => {
    const boom = class {
      constructor() {
        throw new Error("no notifications here");
      }
    };
    const s = await setup(opts({ Notification: boom as never }), true);
    expect(await install(s)).toMatchObject({ kind: "restartRequired" });
    expect(await signIn(s.bridge)).toMatchObject({ kind: "ok" });
  });
});
