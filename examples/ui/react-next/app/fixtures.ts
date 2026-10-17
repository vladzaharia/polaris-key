// The Tidewater fixture is an in-memory stand-in for the host side of
// `@polaris-key/react`. `desktopAdapter({ bridge })` drives it as it drives an Electron host,
// so the sample runs the gate, key, device-limit and sign-in paths with no Worker or network.
//
// `?state=ok|grace|expired|revoked` pins the gate for one load.
import {
  servicesFromList,
  type JSONValue,
  type ServicesMap,
} from "@polaris-key/react/core";
import type {
  BridgeActivation,
  BridgeOidcPoll,
  BridgeState,
  PolarisBridge,
} from "@polaris-key/react/desktop";

/** The key that activates the fixture. */
export const FIXTURE_KEY = "pkey_tidewater_7Q2Mx9cLr4TbV0aZ3WPLDA";

/** Discovery's `core.presentation` for Tidewater; the kit reads this without sample theme code. */
export const TIDEWATER = {
  name: "Tidewater Studio",
  developerName: "Harbor Audio",
  accent: "#369186",
};

const SERVICES: ServicesMap = servicesFromList([
  "license",
  "config",
  "identity",
  "update",
]);
const MANAGE =
  "https://key.plrs.im/activate?product=tidewater&next=free-device";
const DAY = 86_400;
const SIGN_IN_MS = 4_000;

type Doc = NonNullable<BridgeState["doc"]>;
type Pinned = "ok" | "grace" | "expired" | "revoked";

const nowSec = (): number => Math.floor(Date.now() / 1000);
function wait(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** The license document once this device holds Tidewater Studio Pro. */
function licenseDoc(pinned: Pinned | null): Doc {
  const now = nowSec();
  return {
    aud: "tidewater",
    iss: "key.plrs.im",
    licenseId: "lic_tidewater_pro",
    deviceId: "dev_9fK2Lw7QmZ",
    issuedAt: now - 3_600,
    expiresAt:
      pinned === "grace" || pinned === "expired" ? now - 60 : now + DAY,
    graceUntil:
      pinned === "grace"
        ? now + 3 * DAY
        : pinned === "expired"
          ? now - 30
          : now + 30 * DAY,
    profile: {
      name: "Mara Fennick",
      firstName: "Mara",
      email: "mara@fennick.studio",
      activatedAt: now - 3_600,
    },
    entitlements: {
      pro: { state: "enforced", value: true, updatedAt: now - 3_600 },
    },
  };
}

const CONFIG: BridgeState["config"] = {
  "audio.sampleRate": { state: "default", value: 48_000, updatedAt: 1 },
  "export.format": { state: "default", value: "wav", updatedAt: 1 },
  "export.loudnessTarget": { state: "enforced", value: -14, updatedAt: 1 },
  "audio.dither": { state: "default", value: true, updatedAt: 1 },
};

/** Tidewater's config catalog, as the host's `client.config.fetchSchema()` answers: the labels,
 *  units and choices the Settings part draws. */
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
    {
      key: "audio.dither",
      kind: "config",
      category: "audio",
      label: "Dither",
      description: "Dither when lowering the bit depth.",
      schema: { type: "boolean" },
    },
  ],
};

const INITIAL_DEVICES = [
  {
    id: "dev_9fK2Lw7QmZ",
    current: true,
    status: "ok",
    label: "Studio MacBook Pro",
    platform: "macos",
    appVersion: "2.4.1",
    lastVerifiedAt: Math.floor(Date.now() / 1000),
  },
  {
    id: "dev_4hQ8nB2xVc",
    current: false,
    status: "ok",
    label: "Mara's iPad",
    platform: "ipados",
    appVersion: "2.4.1",
    lastVerifiedAt: Math.floor(Date.now() / 1000) - 3 * DAY,
  },
  {
    id: "dev_7tR1kP5sJd",
    current: false,
    status: "ok",
    label: null,
    platform: "windows",
    appVersion: "2.3.0",
    lastVerifiedAt: Math.floor(Date.now() / 1000) - 12 * DAY,
  },
];

function pinnedFromUrl(): Pinned | null {
  if (typeof location === "undefined") return null;
  const state = new URLSearchParams(location.search).get("state");
  return state === "ok" ||
    state === "grace" ||
    state === "expired" ||
    state === "revoked"
    ? state
    : null;
}

/** A Tidewater host for `desktopAdapter({ bridge })`. */
export function tidewaterBridge(): PolarisBridge {
  const pinned = pinnedFromUrl();
  const base = (): BridgeState => ({
    activation: null,
    doc: null,
    capabilities: SERVICES,
    config: CONFIG,
    presentation: TIDEWATER,
  });
  const licensed = (): BridgeState => ({
    ...base(),
    activation: "token",
    doc: licenseDoc(pinned),
    lastVerifiedAt: Date.now(),
    highWaterMark: nowSec() - 60,
    ...(pinned === "revoked" ? { lastSyncUnauthorized: true } : {}),
  });

  let state: BridgeState = pinned ? licensed() : base();
  let devices = INITIAL_DEVICES.map((device) => ({ ...device }));
  let local: Record<string, JSONValue> = {};
  const limited = new Set<string>();
  const flows = new Map<string, number>();
  const listeners = new Set<(next: BridgeState) => void>();
  const push = (next: BridgeState) => {
    state = next;
    for (const listener of listeners) listener(state);
  };

  return {
    version: 4,
    async getSyncState() {
      return state;
    },
    async refresh() {
      await wait(300);
      return state;
    },
    async beginSignIn() {
      const flowId = `flow_${flows.size + 1}`;
      flows.set(flowId, Date.now());
      return {
        flowId,
        verificationUrl: "https://key.plrs.im/device?code=TDWR-4821",
        verificationUri: "https://key.plrs.im/device",
        userCode: "TDWR-4821",
        expiresAt: nowSec() + 600,
        interval: 1,
      };
    },
    async pollSignIn(flowId): Promise<BridgeOidcPoll> {
      const started = flows.get(flowId);
      if (started === undefined) return { kind: "expired" };
      if (Date.now() - started < SIGN_IN_MS) return { kind: "pending" };
      flows.delete(flowId);
      push(licensed());
      return {
        kind: "ok",
        identity: { name: "Mara Fennick", email: "mara@fennick.studio" },
      };
    },
    async submitKey(key): Promise<BridgeActivation> {
      await wait(600);
      if (!key.startsWith("pkey_tidewater_")) return { kind: "unauthorized" };
      if (key !== FIXTURE_KEY && !limited.has(key)) {
        limited.add(key);
        return {
          kind: "device-limit",
          limit: 3,
          deviceCount: 3,
          manageUrl: MANAGE,
        };
      }
      push(licensed());
      return { kind: "ok" };
    },
    async signOut() {
      push(base());
    },
    async fetchSchema() {
      return CATALOG as unknown as JSONValue;
    },
    async invoke(service, method, args) {
      if (service === "config" && method === "set") {
        const { key, value } = (args ?? {}) as {
          key?: string;
          value?: unknown;
        };
        if (typeof key !== "string") throw new Error("Invalid setting.");
        local = { ...local, [key]: value as never };
        push({ ...state, localConfig: local });
        return null;
      }
      if (service === "config" && method === "clear") {
        const { key } = (args ?? {}) as { key?: string };
        const { [key ?? ""]: _gone, ...rest } = local;
        local = rest;
        push({ ...state, localConfig: local });
        return null;
      }
      if (service === "devices" && method === "list") return devices;
      if (service === "devices" && method === "rename") {
        const { deviceId, label } =
          args && typeof args === "object"
            ? (args as { deviceId?: unknown; label?: unknown })
            : {};
        if (
          typeof deviceId !== "string" ||
          (label !== null && typeof label !== "string")
        ) {
          throw new Error("Invalid device rename.");
        }
        devices = devices.map((device) =>
          device.id === deviceId ? { ...device, label } : device,
        );
        return null;
      }
      if (service === "devices" && method === "deauthorize") {
        const { deviceId } =
          args && typeof args === "object"
            ? (args as { deviceId?: unknown })
            : {};
        if (typeof deviceId !== "string") {
          throw new Error("Invalid device deauthorization.");
        }
        devices = devices.filter((device) => device.id !== deviceId);
        return null;
      }
      if (service === "update" && method === "check") {
        return {
          version: "2.5.0",
          tag: "v2.5.0",
          url: "https://dl.plrs.im/tidewater/2.5.0",
          updateAvailable: true,
        };
      }
      // The presentation icon and unsupported verbs are intentionally unavailable: the kit
      // falls back to Tidewater's monogram and reports missing capabilities honestly.
      return null;
    },
    on(_event, callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
}
