// The Tidewater fixture: an in-memory stand-in for the host side of `@polaris-key/react`'s
// desktop bridge, so the sample runs with no Worker, no network and no keys. The real adapter
// (`desktopAdapter`) drives it exactly as it drives an Electron host: the gate, the key step,
// the device limit and the sign-in hand-off are the SDK's own code paths.
//
//   activate   FIXTURE_KEY activates. Any other Tidewater key hits the device limit (3 of 3)
//              the first time and activates the next (as if you had freed a seat on the
//              portal page "Replace a device" opens). Another product's key is refused.
//   sign in    shows a code, then signs in as Mara Fennick about four seconds later.
//   sign out   back to Welcome.
//
// `?state=` on the page's address pins the gate for one load: ok, grace, expired or revoked.

import { servicesFromList, type ServicesMap } from "@polaris-key/react/core";
import type {
  BridgeActivation,
  BridgeOidcPoll,
  BridgeState,
  PolarisBridge,
} from "@polaris-key/react/desktop";

/** The key that activates. */
export const FIXTURE_KEY = "pkey_tidewater_7Q2Mx9cLr4TbV0aZ3WPLDA";

/** What discovery's `core.presentation` says about Tidewater (the kit reads it, no theme code). */
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The license document once this device holds Tidewater Studio Pro. */
function licenseDoc(pinned: Pinned | null): Doc {
  const now = nowSec();
  return {
    aud: "tidewater",
    iss: "key.plrs.im",
    licenseId: "lic_tidewater_pro",
    deviceId: "dev_9fK2Lw7QmZ",
    issuedAt: now - 3_600,
    // Grace and expiry are the same document with the clock moved past its expiry.
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

/** The devices on Mara's license, as the host's `client.devices.list()` answers. */
const DEVICES = [
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
  const v = new URLSearchParams(location.search).get("state");
  return v === "ok" || v === "grace" || v === "expired" || v === "revoked"
    ? v
    : null;
}

/** A Tidewater host: the bridge `desktopAdapter({ bridge })` drives. */
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
  const limited = new Set<string>();
  const flows = new Map<string, number>();
  const listeners = new Set<(s: BridgeState) => void>();
  const push = (next: BridgeState) => {
    state = next;
    for (const l of listeners) l(state);
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
    async invoke(service, method) {
      if (service === "devices" && method === "list") return DEVICES;
      if (service === "update" && method === "check")
        return {
          version: "2.5.0",
          tag: "v2.5.0",
          url: "https://dl.plrs.im/tidewater/2.5.0",
          updateAvailable: true,
        };
      // Everything else (the presentation icon among them) is "not here": the kit keeps the
      // product's monogram.
      return null;
    },
    on(_event, cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
