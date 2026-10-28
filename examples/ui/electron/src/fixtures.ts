// The Tidewater fixture: an in-memory stand-in for `PolarisKeyClient` with just the surface
// `exposePolarisBridge` calls, so the sample runs with no Worker, no network and no keys. The real
// bridge, the real preload and the real React kit run on top of it unchanged.
//
//   activate   FIXTURE_KEY activates. Any other Tidewater key hits the device limit (3 of 3)
//              the first time and activates the next. Another product's key is refused.
//   sign in    shows a code, then signs in as Mara Fennick about four seconds later.
//   update     "2.5.0" is offered; install reports progress as electron-updater does.
//
// TIDEWATER_STATE pins the gate for one run: ok, grace, expired, revoked, version-too-old,
// version-too-new or channel-not-entitled. Without it the first screen is Activate.

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { PolarisKeyClient } from "@polaris-key/node";

export const FIXTURE_KEY = "pkey_tidewater_7Q2Mx9cLr4TbV0aZ3WPLDA";
const TIDEWATER = {
  name: "Tidewater Studio",
  developerName: "Harbor Audio",
  accent: "#369186",
};
import { ICON_PNG_BASE64 } from "./icon";

const ICON = new Uint8Array(Buffer.from(ICON_PNG_BASE64, "base64"));
// The kit verifies the bytes against this hash before it draws them.
const PRESENTATION = {
  ...TIDEWATER,
  icon: {
    sha256: createHash("sha256").update(ICON).digest("hex"),
    contentType: "image/png",
    width: 128,
    height: 128,
    original: "https://dl.plrs.im/tidewater/icon.png",
    sizes: [],
  },
};
const SERVICES = ["license", "config", "identity", "release", "update"];
const MANAGE =
  "https://polaris.locker/activate?product=tidewater&next=free-device";
const DAY = 86_400;
const nowSec = () => Math.floor(Date.now() / 1000);
const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });

const BLOCKS: Record<string, { reason: string; allowedRange?: object }> = {
  "version-too-old": {
    reason: "version-too-old",
    allowedRange: { min: "2.5.0" },
  },
  "version-too-new": {
    reason: "version-too-new",
    allowedRange: { max: "2.4.9" },
  },
  "channel-not-entitled": { reason: "channel-not-entitled" },
};

const CATALOG = {
  schemaVersion: 1,
  entries: [
    {
      key: "audio.sampleRate",
      kind: "config",
      category: "audio",
      label: "Sample rate",
      description: "Samples per second.",
      schema: { type: "number", enum: [44_100, 48_000, 96_000] },
      ui: { unit: "Hz", widget: "select" },
    },
    {
      key: "export.format",
      kind: "config",
      category: "export",
      label: "Export format",
      description: "The file format for exports.",
      schema: { type: "string", enum: ["wav", "flac", "mp3"] },
      ui: { optionLabels: { wav: "WAV", flac: "FLAC", mp3: "MP3" } },
    },
    {
      key: "export.loudnessTarget",
      kind: "config",
      category: "export",
      label: "Loudness target",
      description: "Set by Harbor Audio.",
      schema: { type: "number", minimum: -30, maximum: -6 },
      ui: { unit: "LUFS" },
      managementDefault: "enforced",
    },
  ],
};
const CONFIG = {
  "audio.sampleRate": { state: "default", value: 48_000, updatedAt: 1 },
  "export.format": { state: "default", value: "wav", updatedAt: 1 },
  "export.loudnessTarget": { state: "enforced", value: -14, updatedAt: 1 },
};

const RELEASE = { version: "2.5.0", seq: 7, sha256: "0".repeat(64) };
const DECISION = {
  action: "binary",
  method: "full",
  release: RELEASE,
  build: "b2501",
  mandatory: false,
  critical: false,
  prestage: [],
  discardStaged: false,
};

export function createFixtureClient(
  pinned: string | undefined = process.env.TIDEWATER_STATE,
): PolarisKeyClient {
  const events = new EventEmitter();
  const state = {
    // A block (version, channel) needs a licence to be blocked: the gate shows its screen.
    licensed: Boolean(pinned) && pinned !== "needs-activation",
  };
  let signedIn = false;
  let local: Record<string, unknown> = {};
  let devices = [
    {
      id: "dev_9fK2Lw7QmZ",
      current: true,
      status: "ok",
      label: "Studio MacBook Pro",
      platform: "macos",
      appVersion: "2.4.1",
      lastVerifiedAt: nowSec(),
    },
    {
      id: "dev_4hQ8nB2xVc",
      current: false,
      status: "ok",
      label: "Mara's iPad",
      platform: "ipados",
      appVersion: "2.4.1",
      lastVerifiedAt: nowSec() - 3 * DAY,
    },
    {
      id: "dev_7tR1kP5sJd",
      current: false,
      status: "ok",
      label: null,
      platform: "windows",
      appVersion: "2.3.0",
      lastVerifiedAt: nowSec() - 12 * DAY,
    },
  ];
  const limited = new Set<string>();
  const changed = () => events.emit("license");

  const doc = () => {
    const now = nowSec();
    const late = pinned === "grace" || pinned === "expired";
    return {
      aud: "tidewater",
      iss: "key.plrs.im",
      licenseId: "lic_tidewater_pro",
      deviceId: "dev_9fK2Lw7QmZ",
      issuedAt: now - 3_600,
      expiresAt: late ? now - 60 : now + DAY,
      graceUntil:
        pinned === "grace"
          ? now + 3 * DAY
          : pinned === "expired"
            ? now - 30
            : now + 30 * DAY,
      profile:
        signedIn || !pinned
          ? {
              name: "Mara Fennick",
              firstName: "Mara",
              email: "mara@fennick.studio",
              activatedAt: now - 3_600,
            }
          : undefined,
      entitlements: {
        pro: { state: "enforced", value: true, updatedAt: now - 3_600 },
      },
    };
  };

  const client = {
    events,
    capabilities: () =>
      Object.fromEntries(SERVICES.map((s) => [s, { enabled: true }])),
    presentation: () => PRESENTATION,
    presentationSource: () => ({ subscribe: () => () => undefined }),
    presentationIcon: async () => ICON,
    getSyncState: () => ({
      activation: state.licensed ? "token" : null,
      doc: state.licensed ? doc() : null,
      lastSyncUnauthorized: pinned === "revoked",
      blocked: pinned ? (BLOCKS[pinned] ?? null) : null,
      lastVerifiedAt: Date.now(),
      highWaterMark: nowSec() - 60,
    }),
    sync: () => wait(300),
    config: {
      entries: () => CONFIG,
      localValues: () => local,
      fetchSchema: async () => CATALOG,
      set: async (key: string, value: unknown) => {
        local = { ...local, [key]: value };
        events.emit("config");
      },
      clear: async (key: string) => {
        const { [key]: _gone, ...rest } = local;
        local = rest;
        events.emit("config");
      },
    },
    license: {
      async activateWithKey(key: string) {
        await wait(600);
        if (!key.startsWith("pkey_tidewater_"))
          return { kind: "unauthorized", code: "unauthorized" };
        if (key !== FIXTURE_KEY && !limited.has(key)) {
          limited.add(key);
          return {
            kind: "device-limit",
            code: "device_limit",
            limit: 3,
            deviceCount: 3,
            manageUrl: MANAGE,
          };
        }
        state.licensed = true;
        changed();
        return { kind: "ok", token: "pkeyt_fixture", schemaVersion: 1 };
      },
    },
    identity: {
      // What the bridge's `beginSignIn` drives: a device-code session (`signIn.start`).
      signIn: {
        async start(_o: { channel: string; deviceName?: string }) {
          const startedAt = Date.now();
          return {
            userCode: "TDWR-4821",
            verificationUri: "https://polaris.locker/device",
            verificationUriComplete:
              "https://polaris.locker/device?user_code=TDWR-4821",
            expiresIn: 600,
            interval: 1,
            expiresAt: nowSec() + 600,
            // A person approving in the browser, about four seconds after the start.
            async wait(_w?: { once?: boolean }) {
              if (Date.now() - startedAt < 4_000)
                return { kind: "pending", interval: 1 };
              signedIn = true;
              state.licensed = true;
              changed();
              return {
                kind: "signedIn",
                subject: null,
                activation: { licenseId: null },
                identity: {
                  name: "Mara Fennick",
                  email: "mara@fennick.studio",
                },
              };
            },
          };
        },
      },
      async signOut() {
        signedIn = false;
        state.licensed = false;
        changed();
      },
    },
    listDevices: async () => devices,
    renameDevice: async (id: string, label: string | null) => {
      devices = devices.map((d) => (d.id === id ? { ...d, label } : d));
    },
    deauthorizeDevice: async (id: string) => {
      devices = devices.filter((d) => d.id !== id);
    },
    devices: { report: async () => null },
    release: {
      changelog: async () => [
        {
          version: "2.5.0",
          date: "2026-10-02T09:00:00Z",
          summary: "Stem export in one click, with loudness matching.",
        },
        {
          version: "2.4.1",
          date: "2026-09-12T09:00:00Z",
          summary: "Track freeze now works with every plug-in.",
        },
      ],
    },
    update: {
      check: async () => ({
        updateAvailable: true,
        version: RELEASE.version,
        url: "https://dl.plrs.im/tidewater/2.5.0",
      }),
      decide: async () => ({ decision: DECISION }),
      // What electronUpdaterDriver reports from autoUpdater's download-progress events.
      async install(
        _d: unknown,
        o: {
          onProgress?: (done: number, total: number) => void;
          signal?: AbortSignal;
        } = {},
      ) {
        const total = 61_000_000;
        for (let i = 1; i <= 30; i++) {
          await wait(150, o.signal);
          o.onProgress?.(Math.round((total * i) / 30), total);
        }
        return {
          kind: "restartRequired",
          version: RELEASE.version,
          restart: async () => undefined,
        };
      },
      markBootAttempt: async () => ({}),
      confirmBoot: async () => undefined,
    },
  };
  return client as unknown as PolarisKeyClient;
}
