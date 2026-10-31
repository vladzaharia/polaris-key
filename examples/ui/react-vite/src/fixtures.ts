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
// A key holds the license with no account (floating): the gate shows Done, "Add your name and
// email" signs in by code and attaches it, and Settings shows "Not in an account" until then.
//
// `?state=` on the page's address pins the gate for one load: ok, grace, expired or revoked (an
// account holds it). `?identity=off` turns Identity off (Add opens polaris.locker). `?attach=`
// other, owned or failed makes Add end on that step.

import {
  servicesFromList,
  type JSONValue,
  type ServicesMap,
} from "@polaris-key/react/core";
import {
  type BridgeActivation,
  type BridgeSignInBegin,
  type BridgeOidcPoll,
  type BridgeState,
  type PolarisBridge,
} from "@polaris-key/react/desktop";

/** The key that activates. */
export const FIXTURE_KEY = "pkey_tidewater_7Q2Mx9cLr4TbV0aZ3WPLDA";

/** What discovery's `core.presentation` says about Tidewater (the kit reads it, no theme code). */
export const TIDEWATER = {
  name: "Tidewater Studio",
  developerName: "Harbor Audio",
  accent: "#369186",
};

const identityOff = (): boolean =>
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).get("identity") === "off";

const services = (): ServicesMap =>
  servicesFromList(
    identityOff()
      ? ["license", "config", "update"]
      : ["license", "config", "identity", "update"],
  );

type Attach = "other" | "owned" | "failed";
function attachFromUrl(): Attach | null {
  if (typeof location === "undefined") return null;
  const v = new URLSearchParams(location.search).get("attach");
  return v === "other" || v === "owned" || v === "failed" ? v : null;
}

/** Who holds the license: nobody (the key alone) or a person. */
interface Holder {
  name: string;
  email: string;
}
const MARA: Holder = { name: "Mara Fennick", email: "mara@fennick.studio" };
const FLOATING: Holder = { name: "", email: "" };
const MANAGE =
  "https://key.plrs.im/activate?product=tidewater&next=free-device";
const DAY = 86_400;
const SIGN_IN_MS = 4_000;

type Doc = NonNullable<BridgeState["doc"]>;
type Pinned = "ok" | "grace" | "expired" | "revoked";

const nowSec = (): number => Math.floor(Date.now() / 1000);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The license document once this device holds Tidewater Studio Pro. */
function licenseDoc(pinned: Pinned | null, holder: Holder): Doc {
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
      name: holder.name,
      firstName: holder.name.split(" ")[0] ?? "",
      email: holder.email,
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

/** The devices on Mara's license, as the host's `client.devices.list()` answers. */
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
    capabilities: services(),
    config: CONFIG,
    presentation: TIDEWATER,
  });
  let holder: Holder = pinned ? MARA : FLOATING;
  // What the last "Add your name and email" typed: the sign-in answers as that person.
  let typed: Holder | null = null;
  const attach = attachFromUrl();
  const licensed = (): BridgeState => ({
    ...base(),
    activation: "token",
    doc: licenseDoc(pinned, holder),
    lastVerifiedAt: Date.now(),
    highWaterMark: nowSec() - 60,
    ...(pinned === "revoked" ? { lastSyncUnauthorized: true } : {}),
  });

  let state: BridgeState = pinned ? licensed() : base();
  let devices = INITIAL_DEVICES.map((d) => ({ ...d }));
  let local: Record<string, JSONValue> = {};
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
    async beginSignIn(opts?: BridgeSignInBegin) {
      // The form's name and email ride the bag; the sign-in answers as that person.
      typed = opts?.loginHint
        ? { name: opts.nameHint ?? "", email: opts.loginHint }
        : null;
      const flowId = `flow_${flows.size + 1}`;
      flows.set(flowId, Date.now());
      return {
        flowId,
        verificationUrl: "https://polaris.locker/device?user_code=TDWR-4821",
        verificationUri: "https://polaris.locker/device",
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
      // The welcome sign-in holds the license for the account. A sign-in made while a key holds
      // it (Add your name and email) changes nothing until the attach.
      if (state.doc === null) {
        holder = MARA;
        push(licensed());
      }
      const who = typed ?? MARA;
      return {
        kind: "ok",
        identity: {
          name: who.name,
          email: attach === "other" ? "someone.else@example.com" : who.email,
        },
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
      holder = pinned ? MARA : FLOATING;
      push(licensed());
      return { kind: "ok" };
    },
    async signOut() {
      holder = FLOATING;
      typed = null;
      push(base());
    },
    async fetchSchema() {
      return CATALOG as unknown as JSONValue;
    },
    async invoke(service, method, args) {
      if (service === "core" && method === "discovery")
        return {
          core: {
            portal: {
              enabled: true,
              activate: "https://polaris.locker/activate?product=tidewater",
            },
          },
        };
      if (service === "identity" && method === "attach") {
        const { confirm } = (args ?? {}) as { confirm?: boolean };
        if (attach === "owned")
          return { kind: "refused", code: "license_owned", status: 409 };
        if (attach === "failed")
          return { kind: "refused", code: "failed", status: 500 };
        if (!confirm)
          return {
            kind: "confirm",
            license: { id: "lic_tidewater_pro", tierId: null, name: null },
          };
        await wait(400);
        holder = typed ?? MARA;
        push(licensed());
        return { kind: "ok", subject: "ps_tidewater_1", attached: "claimed" };
      }
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
        const { deviceId, label } = (args ?? {}) as {
          deviceId?: string;
          label?: string | null;
        };
        devices = devices.map((d) =>
          d.id === deviceId ? { ...d, label: label ?? null } : d,
        );
        return null;
      }
      if (service === "devices" && method === "deauthorize") {
        const { deviceId } = (args ?? {}) as { deviceId?: string };
        devices = devices.filter((d) => d.id !== deviceId);
        return null;
      }
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
    onOpen(cb) {
      openers.add(cb);
      return () => openers.delete(cb);
    },
    on(_event, cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

const openers = new Set<(view: "settings" | "update") => void>();

/** What a desktop host's menu item ("Manage License…") does: the kit's Settings dialog, with the
 *  account pane (and its "Not in an account" row) above the rows. */
export function openFromMenu(view: "settings" | "update" = "settings"): void {
  for (const open of openers) open(view);
}
