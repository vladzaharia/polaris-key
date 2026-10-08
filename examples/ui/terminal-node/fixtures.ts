// The Tidewater fixture: an in-memory stand-in for `PolarisKeyClient` with just the surface the
// terminal kit's flows call, so the sample runs with no Worker, no network and no keys. It is
// modelled on the stub the kit's own goldens use (packages/sdk-node/test/cli/harness.ts):
// Tidewater Studio by Harbor Audio, three seats, Mara Fennick's devices.
//
// It behaves like the real thing, a little slowed down so the spinners show:
//
//   activate   the fixture key below activates; any other Tidewater key hits the device limit
//              (3 of 3 seats, with the portal link that frees one); a key for another product
//              is refused
//   login      finishes by itself about four seconds after it starts (Esc cancels)
//   status     follows what you did, across runs: the state is saved in a small JSON file
//              (TIDEWATER_FIXTURE_FILE, default: tidewater-fixture.json in the OS temp directory)
//
// TIDEWATER_STATE pins the gate for one run, to see the other screens without a real license:
// ok, grace, last-day, needs-activation, expired, revoked, version-too-old, version-too-new or
// channel-not-entitled.

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ActivationResult,
  DeviceInfo,
  LicenseInfo,
  PolarisKeyClient,
  SignInPrompt,
  SignInResult,
} from "@polaris-key/node";
import type { ProductPresentation } from "@polaris-key/node/cli";

/** The key that activates. Its secret is never printed: the kit masks it everywhere. */
export const FIXTURE_KEY = "pkey_tidewater_7Q2Mx9cLr4TbV0aZ3WPLDA";

/** What the SDK's presentation accessor returns for Tidewater (its accent comes from its icon). */
export const TIDEWATER: ProductPresentation = {
  name: "Tidewater Studio",
  developerName: "Harbor Audio",
  accent: "#369186",
};

const SLUG = "tidewater";
const PORTAL = "https://key.plrs.im/portal/tidewater/devices";
const ACCOUNT = { name: "Mara Fennick", email: "mara@fennick.studio" };
/** The license's profile once Mara has signed in on this device. */
const PROFILE = { ...ACCOUNT, firstName: "Mara", activatedAt: 1_788_000_000 };
const DAY = 86_400;

const GATE_STATES = [
  "ok",
  "grace",
  "last-day",
  "needs-activation",
  "expired",
  "revoked",
  "version-too-old",
  "version-too-new",
  "channel-not-entitled",
] as const;
type PinnedState = (typeof GATE_STATES)[number];

/** What survives between runs: how this device got its license, and the user's settings. */
interface Saved {
  license: "key" | "account" | null;
  signedIn: boolean;
  config: Record<string, unknown>;
}

const FRESH: Saved = { license: null, signedIn: false, config: {} };

/** The catalog's settings: their defaults, and one the operator enforces. */
const SETTINGS: ReadonlyArray<{
  key: string;
  value: unknown;
  enforced?: boolean;
}> = [
  { key: "audio.sampleRate", value: 48000 },
  { key: "export.format", value: "wav" },
  { key: "export.loudnessTarget", value: -14, enforced: true },
  { key: "ui.theme", value: "dark" },
];

export interface FixtureOptions {
  /** Where the fixture keeps its state between runs. */
  file?: string;
  /** Pin the gate for this run (TIDEWATER_STATE). */
  state?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

/** Wait `ms`; an aborted `signal` rejects with its reason, as the SDK's waits do. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

const platformName = (p: NodeJS.Platform): string =>
  p === "darwin" ? "macOS" : p === "win32" ? "Windows" : p;

/** An error the kit maps to its copy by `code`, as the SDK's `PolarisError` carries one. */
const coded = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

/**
 * The fixture client. Typed as `PolarisKeyClient` because the flows take one; it implements only
 * what they call (the kit's goldens use the same shape).
 */
export function createFixtureClient(o: FixtureOptions = {}): PolarisKeyClient {
  const env = o.env ?? process.env;
  const file =
    o.file ??
    env.TIDEWATER_FIXTURE_FILE ??
    join(tmpdir(), "tidewater-fixture.json");
  const requested = o.state ?? env.TIDEWATER_STATE;
  const pinned = GATE_STATES.find((s) => s === requested) ?? null;

  let saved: Saved;
  try {
    saved = { ...FRESH, ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    saved = { ...FRESH, config: {} };
  }
  const save = (change: Partial<Saved>) => {
    saved = { ...saved, ...change };
    writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);
  };

  const now = () => Math.floor(Date.now() / 1000);
  const gate = (): PinnedState =>
    pinned ?? (saved.license ? "ok" : "needs-activation");

  const status = () => {
    const s = gate();
    if (s === "ok") return { status: "ok", graceUntil: now() + 14 * DAY };
    if (s === "grace") return { status: "grace", graceUntil: now() + 3 * DAY };
    if (s === "last-day")
      return { status: "grace", graceUntil: now() + DAY / 2 };
    return { status: s };
  };

  const licenseInfo = (): LicenseInfo | null => {
    if (gate() === "needs-activation") return null;
    return {
      licenseId: "lic_tw_2Hq7",
      tier: "pro",
      tierLabel: "Pro",
      deviceLimit: 3,
      profile: saved.signedIn ? PROFILE : null,
      entitledChannels: ["stable"],
      status: status().status as LicenseInfo["status"],
    };
  };

  const devices = (): DeviceInfo[] => [
    {
      id: "dev_9fK2Lw7QmZ",
      current: true,
      status: "ok",
      label: "Work laptop",
      platform: platformName(process.platform),
      arch: process.arch,
      lastVerifiedAt: now() - 3600,
    },
    {
      id: "dev_4hQ8nB2xVc",
      current: false,
      status: "ok",
      label: "Mara's iPad",
      platform: "iPadOS",
    },
    {
      id: "dev_7tR1kP5sJd",
      current: false,
      status: "ok",
      label: "MacBook Pro",
      platform: "macOS",
      arch: "arm64",
    },
  ];

  const settings = () =>
    SETTINGS.map((s) => ({
      key: s.key,
      value: (s.enforced ? undefined : saved.config[s.key]) ?? s.value,
      enforced: s.enforced === true,
    }));

  type PackEvent = {
    packId: string;
    phase: "download";
    done: number;
    total: number;
  };
  const packListeners = new Set<(e: PackEvent) => void>();

  const release = { version: "2.5.0", seq: 7 };

  return {
    product: SLUG,
    core: {
      version: "2.4.1",
      channel: "stable",
      deviceId: "dev_9fK2Lw7QmZ",
      baseUrl: "https://key.plrs.im",
    },

    // The presentation seam (the SDK's accessor for the product's name, developer and accent).
    presentation: () => TIDEWATER,

    status,
    isLicensed: () => ["ok", "grace", "last-day"].includes(gate()),
    sync: () => sleep(700),
    storeStatus: async () => ({ backend: "file" }),
    discover: async () => ({ kind: "ok" }),
    supports: () => ({ supported: true }),
    capabilities: () => ({
      license: { enabled: true },
      config: { enabled: true },
      release: { enabled: true },
      distribution: { enabled: true },
      update: { enabled: true },
      identity: { enabled: true },
      sync: { enabled: false },
    }),

    license: {
      licenseInfo,
      getProfile: () => (saved.signedIn ? PROFILE : null),
      async activateWithKey(key: string): Promise<ActivationResult> {
        await sleep(900);
        if (key === FIXTURE_KEY) {
          save({ license: "key" });
          return { kind: "ok", token: "pkeyt_fixture", schemaVersion: 1 };
        }
        if (!key.startsWith(`pkey_${SLUG}_`))
          return { kind: "unauthorized", code: "unauthorized" };
        return {
          kind: "device-limit",
          code: "device_limit",
          limit: 3,
          deviceCount: 3,
          manageUrl: PORTAL,
        };
      },
      async enroll(): Promise<ActivationResult> {
        await sleep(600);
        return { kind: "enroll-disabled", code: "enroll_disabled" };
      },
      async deactivate() {
        await sleep(600);
        save({ license: null });
      },
    },

    identity: {
      async beginSignIn(): Promise<SignInPrompt> {
        await sleep(500);
        return {
          deviceCode: "fixture-device-code",
          userCode: "WDJB-MJHT",
          verificationUri: "https://key.plrs.im/device",
          verificationUriComplete: "https://key.plrs.im/device?code=WDJB-MJHT",
          expiresIn: 600,
          interval: 5,
          expiresAt: now() + 600,
          deviceName: "Work laptop",
        };
      },
      async waitForSignIn(
        _prompt: SignInPrompt,
        opts: { signal?: AbortSignal } = {},
      ): Promise<SignInResult> {
        await sleep(4000, opts.signal);
        save({ signedIn: true, license: saved.license ?? "account" });
        return { status: "ready", identity: ACCOUNT };
      },
      async signOut() {
        await sleep(400);
        save({
          signedIn: false,
          license: saved.license === "account" ? null : saved.license,
        });
      },
    },

    listDevices: async () => {
      await sleep(500);
      return devices();
    },
    renameDevice: () => sleep(400),
    deauthorizeDevice: () => sleep(400),
    devices: {
      register: async () => ({ kind: "ok", deviceId: "dev_9fK2Lw7QmZ" }),
    },

    update: {
      decidable: true,
      outlet: null,
      check: async () => ({
        updateAvailable: true,
        version: release.version,
        url: "https://dl.plrs.im/tidewater/2.5.0",
      }),
      decide: async () => {
        await sleep(600);
        return {
          decision: {
            action: "binary",
            method: "full",
            release,
            build: "b2501",
            mandatory: false,
            critical: false,
            prestage: [],
            discardStaged: false,
          },
        };
      },
      async install(
        _decision: unknown,
        opts: {
          onProgress?: (done: number, total: number) => void;
          signal?: AbortSignal;
        } = {},
      ) {
        const total = 61_000_000;
        for (let step = 1; step <= 30; step++) {
          await sleep(100, opts.signal);
          opts.onProgress?.(Math.round((total * step) / 30), total);
        }
        return { kind: "restartRequired", version: release.version };
      },
      packs: {
        state: async () => ({
          active: { "drum-kits": { packId: "drum-kits", version: "1.2.0" } },
          running: { "drum-kits": { packId: "drum-kits", version: "1.2.0" } },
          inflight: {},
          stateIssue: null,
        }),
        on(listener: (e: PackEvent) => void) {
          packListeners.add(listener);
          return () => packListeners.delete(listener);
        },
        async ensure(packIds: string[]) {
          const total = 24_000_000;
          for (const packId of packIds)
            for (let step = 1; step <= 15; step++) {
              await sleep(100);
              for (const l of packListeners)
                l({
                  packId,
                  phase: "download",
                  done: (total * step) / 15,
                  total,
                });
            }
          return packIds.map((packId) => ({ packId, version: "1.0.0" }));
        },
      },
    },

    release: {
      changelog: async () => {
        await sleep(300);
        return [
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
          {
            version: "2.4.0",
            date: "2026-08-28T09:00:00Z",
            summary: "A tape-saturation module and 40 new presets.",
          },
        ];
      },
    },

    config: {
      listUserConfig: settings,
      getConfigSource: (key: string) => {
        const s = SETTINGS.find((e) => e.key === key);
        if (s?.enforced) return "enforced";
        if (key in saved.config) return "local";
        return s ? "remote-default" : "fallback";
      },
      getConfig: (key: string, fallback: unknown) =>
        settings().find((e) => e.key === key)?.value ?? fallback,
      getSecret: () => null,
      async set(key: string, value: unknown) {
        if (SETTINGS.find((e) => e.key === key)?.enforced)
          throw coded(
            "managed_by_admin",
            `${key} is managed by an administrator.`,
          );
        save({ config: { ...saved.config, [key]: value } });
      },
      async clear(key: string) {
        const { [key]: _gone, ...rest } = saved.config;
        save({ config: rest });
      },
      mintToken: async (recipeId: string) => ({
        token: `fixture.${recipeId}.token`,
        expiresAt: now() + 3600,
      }),
    },

    importBundle: async (jws: string) => {
      await sleep(400);
      if (!jws.startsWith("eyJ")) throw coded("bundle", "not a signed bundle");
      save({ license: "key" });
      return { bundleId: "bdl_tw_1", imported: ["license"] };
    },
  } as unknown as PolarisKeyClient;
}
