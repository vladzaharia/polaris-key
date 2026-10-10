// The drop-in kit's screens as a host page renders them, over the tests' fake desktop bridge: one
// scene per component state the responsive suite measures. The host page sets no font of its
// own, so a scene also shows what the kit does on a bare page; the "host" preset adds a host
// font and a host accent, the "polaris-key" preset the brand.

import type { ReactNode } from "react";
import { PolarisKeyProvider } from "../../src/react/Provider.js";
import { LicenseGate } from "../../src/components/LicenseGate.js";
import { DeviceManager } from "../../src/components/DeviceManager.js";
import { ConfigPanel } from "../../src/components/ConfigPanel.js";
import { UpdatePrompt } from "../../src/components/UpdatePrompt.js";
import { PolarisLogout } from "../../src/components/PolarisLogout.js";
import { desktopAdapter } from "../../src/desktop/desktopAdapter.js";
import type {
  BridgeActivation,
  BridgeState,
} from "../../src/desktop/bridge.js";
import {
  PolarisError,
  type PolarisAdapter,
  type PolarisState,
} from "../../src/core/index.js";
import {
  NOW_SEC,
  emptyBridgeState,
  entry,
  makeDoc,
  makeFakeBridge,
  okBridgeState,
  services,
} from "../fixtures.js";

export type Scheme = "dark" | "light";

/** Which look a scene renders in: the neutral default, the Polaris Key brand, or a host that
 *  sets its own font and points the accent at its own variable. */
export type Preset = "neutral" | "polaris-key" | "host";

let preset: Preset = "neutral";

/** The preset the next `provider()` renders in (the suite sets it per run). */
export function setPreset(next: Preset): void {
  preset = next;
}

/** The font a preset's kit text starts with ("system-ui" on a page that sets none). */
export function presetFont(p: Preset): string {
  return p === "polaris-key"
    ? "Rubik"
    : p === "host"
      ? "Trebuchet MS"
      : "system-ui";
}

export interface Scene {
  /** The directory the screenshots go in: `react.<id>`. */
  id: string;
  render: (scheme: Scheme) => { node: ReactNode; adapter: PolarisAdapter };
  /** Steps after the first render (typing a key, opening a form), once `before` is there. */
  act?: (root: HTMLElement) => Promise<void>;
  before?: string;
  /** The selector of the screen's main action, which must be in the first viewport. `null`
   *  for a notice with no action of its own. */
  primary: string | null;
  /** The element the scene is ready on. */
  ready: string;
  /** The element that holds focus once the scene is ready. */
  focus?: string;
  /** A full-window gate screen: full-bleed on a phone. */
  gate?: boolean;
}

export const MANAGE =
  "https://key.plrs.im/portal/tidewater-studio-professional-mastering-suite/devices?return=https%3A%2F%2Fexample.com";
export const ALL = services("license", "config", "identity", "update");

export const roster = [
  {
    id: "dev_9fK2Lw7QmZ",
    current: true,
    status: "ok",
    label: "Mara Fennick's 16-inch MacBook Pro (Studio B, second floor)",
    platform: "macos",
    appVersion: "2.4.1",
  },
  {
    id: "dev_4hQ8nB2xVc",
    current: false,
    status: "ok",
    label: "Mara's iPad",
    platform: "ipados",
    appVersion: "2.4.1",
  },
  {
    id: "dev_7tR1kP5sJdLongIdentifierValue0123456789",
    current: false,
    status: "ok",
    label: null,
    platform: "windows",
    appVersion: "2.3.0",
  },
];

export function adapterFor(
  state: BridgeState,
  tweak?: (bridge: ReturnType<typeof makeFakeBridge>) => void,
): PolarisAdapter {
  const bridge = makeFakeBridge(state);
  bridge.invoke = (async (service: string, method: string) => {
    if (service === "devices" && method === "list") return roster;
    if (service === "update" && method === "check")
      return {
        version: "2.5.0",
        tag: "v2.5.0",
        url: "https://dl.example/2.5.0",
        updateAvailable: true,
      };
    return undefined;
  }) as never;
  tweak?.(bridge);
  return desktopAdapter({
    bridge,
    now: () => NOW_SEC,
    expectServices: state.capabilities ?? ALL,
  });
}

/** The adapter with a refused refresh carrying the portal link forced onto every snapshot. */
function withManageError(real: PolarisAdapter): PolarisAdapter {
  const error = new PolarisError(
    "refresh-failed",
    "This license is already on all its devices.",
    "device_limit",
    undefined,
    { manageUrl: MANAGE },
  );
  let from: PolarisState | null = null;
  let out: PolarisState | null = null;
  const snapshot = (): PolarisState => {
    const s = real.snapshot();
    if (s !== from) {
      from = s;
      out = { ...s, error: { ...s.error, license: error } };
    }
    return out!;
  };
  return Object.assign(Object.create(real) as PolarisAdapter, { snapshot });
}

/** The host app around a component. `data-host-content` marks the host's own text, which the
 *  suite does not hold to the kit's rules (it sets no font, on purpose). */
export function host(children: ReactNode): ReactNode {
  return (
    <main style={{ padding: "1rem" }} data-host-content="">
      <h1 style={{ margin: "0 0 1rem" }}>Tidewater Studio</h1>
      {children}
    </main>
  );
}

export function provider(
  adapter: PolarisAdapter,
  scheme: Scheme | "system",
  children: ReactNode,
): { node: ReactNode; adapter: PolarisAdapter } {
  const copy = { productName: "Tidewater Studio" };
  const theme =
    preset === "polaris-key"
      ? { branding: "polaris-key" as const, copy }
      : preset === "host"
        ? {
            copy,
            tokens: {
              fontFamily: "inherit",
              accent: "var(--app-accent)",
              accentHover: "var(--app-accent)",
              accentText: "#ffffff",
            },
          }
        : { copy };
  const node = (
    <PolarisKeyProvider
      productSlug="tidewater"
      adapter={adapter}
      colorScheme={scheme}
      theme={theme}
    >
      {children}
    </PolarisKeyProvider>
  );
  return {
    adapter,
    node:
      preset === "host" ? (
        <div
          style={
            {
              fontFamily: '"Trebuchet MS", sans-serif',
              "--app-accent": "#0b5cad",
            } as React.CSSProperties
          }
        >
          {node}
        </div>
      ) : (
        node
      ),
  };
}

const app = host(<p>Host app content.</p>);

/** A device-code sign-in the host started: the code, the page it belongs to, and `seconds` of
 *  life left on this machine's clock. */
function handoff(seconds: number) {
  return {
    flowId: "flow-1",
    userCode: "WDJB-MJHT",
    verificationUrl: "https://key.plrs.im/activate?code=WDJB-MJHT",
    verificationUri: "https://key.plrs.im/activate",
    expiresAt: Date.now() / 1000 + seconds,
  };
}

async function typeKey(root: HTMLElement): Promise<void> {
  const reveal = root.querySelector<HTMLButtonElement>(
    "[data-polaris-use-key]",
  );
  reveal?.click();
  await new Promise((r) => setTimeout(r, 0));
  const input = root.querySelector<HTMLInputElement>(
    "[data-polaris-key-input]",
  );
  if (!input) throw new Error("no key field");
  // React tracks the value through the native setter; an input event then reaches onChange.
  const set = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  set.call(input, "pkey_tidewater_9ZZZx9cLr4TbV0aZ3WPLDB");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  input.form!.requestSubmit();
}

function gate(
  state: BridgeState,
  scheme: Scheme,
  tweak?: (bridge: ReturnType<typeof makeFakeBridge>) => void,
  wrap: (a: PolarisAdapter) => PolarisAdapter = (a) => a,
) {
  return provider(
    wrap(adapterFor(state, tweak)),
    scheme,
    <LicenseGate returnUrl="https://example.com">{app}</LicenseGate>,
  );
}

const blocked = (reason: string, allowedRange?: object): BridgeState =>
  okBridgeState({
    capabilities: ALL,
    blocked: { reason, ...(allowedRange ? { allowedRange } : {}) },
  } as never);

export const SCENES: Scene[] = [
  {
    id: "license-gate.login",
    render: (scheme) => gate(emptyBridgeState({ capabilities: ALL }), scheme),
    ready: "[data-polaris-oidc]",
    primary: "[data-polaris-oidc]",
    focus: "[data-polaris-oidc]",
    gate: true,
  },
  {
    id: "license-gate.device-limit",
    render: (scheme) =>
      gate(emptyBridgeState({ capabilities: ALL }), scheme, (bridge) => {
        bridge.submitKey = async () =>
          ({
            kind: "device-limit",
            limit: 3,
            deviceCount: 3,
            manageUrl: MANAGE,
          }) as BridgeActivation;
      }),
    act: typeKey,
    before: "[data-polaris-use-key]",
    ready: "[data-polaris-free-device]",
    primary: "[data-polaris-free-device]",
    focus: "[data-polaris-free-device]",
    gate: true,
  },
  {
    id: "signin-handoff",
    render: (scheme) =>
      gate(emptyBridgeState({ capabilities: ALL }), scheme, (bridge) => {
        bridge.beginSignIn = async () => handoff(587);
      }),
    act: async (root) => {
      root.querySelector<HTMLButtonElement>("[data-polaris-oidc]")!.click();
    },
    before: "[data-polaris-oidc]",
    ready: '[data-polaris-handoff="waiting"]',
    primary: "[data-polaris-handoff-open]",
    focus: "[data-polaris-handoff-open]",
    gate: true,
  },
  {
    id: "signin-handoff.expired",
    render: (scheme) =>
      gate(emptyBridgeState({ capabilities: ALL }), scheme, (bridge) => {
        bridge.beginSignIn = async () => handoff(1);
      }),
    act: async (root) => {
      root.querySelector<HTMLButtonElement>("[data-polaris-oidc]")!.click();
    },
    before: "[data-polaris-oidc]",
    ready: '[data-polaris-handoff="expired"]',
    primary: "[data-polaris-handoff-again]",
    focus: "[data-polaris-handoff-again]",
    gate: true,
  },
  {
    id: "license-gate.error",
    render: (scheme) =>
      gate(
        emptyBridgeState({ capabilities: ALL }),
        scheme,
        undefined,
        withManageError,
      ),
    ready: '[data-polaris-gate="error"] [data-polaris-actions]',
    primary: '[data-polaris-gate="error"] [data-polaris-actions] button',
    focus: '[data-polaris-gate="error"] [data-polaris-actions] button',
    gate: true,
  },
  {
    id: "license-gate.network-error",
    render: (scheme) =>
      gate(emptyBridgeState({ capabilities: ALL }), scheme, (bridge) => {
        bridge.getSyncState = async () => {
          throw new Error("fetch failed");
        };
      }),
    ready: '[data-polaris-gate="error"] [data-polaris-actions]',
    primary: '[data-polaris-gate="error"] [data-polaris-actions] button',
    focus: '[data-polaris-gate="error"] [data-polaris-actions] button',
    gate: true,
  },
  {
    id: "license-gate.loading",
    render: (scheme) =>
      gate(emptyBridgeState({ capabilities: ALL }), scheme, (bridge) => {
        bridge.getSyncState = () => new Promise(() => undefined);
      }),
    ready: '[data-polaris-gate="loading"] [role="status"]',
    primary: null,
    gate: false,
  },
  {
    id: "license-gate.expired",
    render: (scheme) =>
      gate(
        okBridgeState({
          capabilities: ALL,
          doc: makeDoc({ issuedAt: 100, expiresAt: 200, graceUntil: 300 }),
        }),
        scheme,
      ),
    ready: '[data-polaris-gate="expired"] [data-polaris-oidc]',
    primary: "[data-polaris-oidc]",
    focus: "[data-polaris-oidc]",
    gate: true,
  },
  {
    id: "license-gate.revoked",
    render: (scheme) =>
      gate(
        okBridgeState({ capabilities: ALL, lastSyncUnauthorized: true }),
        scheme,
      ),
    ready: '[data-polaris-gate="revoked"] [data-polaris-oidc]',
    primary: "[data-polaris-oidc]",
    focus: "[data-polaris-oidc]",
    gate: true,
  },
  {
    id: "license-gate.revoked.handoff",
    render: (scheme) =>
      gate(
        okBridgeState({ capabilities: ALL, lastSyncUnauthorized: true }),
        scheme,
        (bridge) => {
          bridge.beginSignIn = async () => handoff(587);
        },
      ),
    act: async (root) => {
      root.querySelector<HTMLButtonElement>("[data-polaris-oidc]")!.click();
    },
    before: "[data-polaris-oidc]",
    ready: '[data-polaris-handoff="waiting"]',
    primary: "[data-polaris-handoff-open]",
    focus: "[data-polaris-handoff-open]",
    gate: true,
  },
  {
    id: "license-gate.version",
    render: (scheme) =>
      gate(blocked("version-too-old", { min: "5.0.0" }), scheme),
    ready: '[data-polaris-gate="version-block"] [data-polaris-actions] button',
    primary:
      '[data-polaris-gate="version-block"] [data-polaris-actions] button',
    focus: '[data-polaris-gate="version-block"] [data-polaris-actions] button',
    gate: true,
  },
  {
    id: "license-gate.version-too-new",
    render: (scheme) =>
      gate(blocked("version-too-new", { max: "3.0.0" }), scheme),
    ready: '[data-polaris-gate="version-block"] [data-polaris-actions] button',
    primary:
      '[data-polaris-gate="version-block"] [data-polaris-actions] button',
    gate: true,
  },
  {
    id: "license-gate.channel",
    render: (scheme) => gate(blocked("channel-not-entitled"), scheme),
    ready: '[data-polaris-gate="version-block"] [data-polaris-actions] button',
    primary:
      '[data-polaris-gate="version-block"] [data-polaris-actions] button',
    gate: true,
  },
  {
    id: "license-gate.grace",
    render: (scheme) =>
      provider(
        adapterFor(
          okBridgeState({
            capabilities: ALL,
            doc: makeDoc({
              issuedAt: 100,
              expiresAt: 200,
              graceUntil: NOW_SEC + 10_000,
            }),
          }),
        ),
        scheme,
        <LicenseGate allowGrace>{app}</LicenseGate>,
      ),
    ready: '[data-polaris-gate="grace"]',
    primary: null,
  },
  {
    id: "update-prompt.dialog",
    render: (scheme) =>
      provider(
        adapterFor(okBridgeState({ capabilities: ALL })),
        scheme,
        <>
          {app}
          <UpdatePrompt variant="dialog" />
        </>,
      ),
    ready: '[data-polaris-update="dialog"] [data-polaris-actions]',
    primary: '[data-polaris-update="dialog"] [data-polaris-actions] button',
    focus: '[data-polaris-update="dialog"] [data-polaris-actions] button',
  },
  {
    id: "update-prompt.failed",
    render: (scheme) =>
      provider(
        adapterFor(okBridgeState({ capabilities: ALL }), (bridge) => {
          const ok = bridge.invoke!;
          bridge.invoke = (async (service: string, method: string) => {
            if (service === "update" && method === "check")
              throw new PolarisError("network-error", "offline");
            return ok(service, method);
          }) as never;
        }),
        scheme,
        <>
          <UpdatePrompt showWhenCurrent />
          {app}
        </>,
      ),
    ready: '[data-polaris-update="failed"] button',
    primary: '[data-polaris-update="failed"] button',
  },
  {
    id: "update-prompt.banner",
    render: (scheme) =>
      provider(
        adapterFor(okBridgeState({ capabilities: ALL })),
        scheme,
        <>
          <UpdatePrompt variant="banner" />
          {app}
        </>,
      ),
    ready: "[data-polaris-update-action]",
    primary: "[data-polaris-update-action]",
  },
  {
    id: "device-manager",
    render: (scheme) =>
      provider(
        adapterFor(okBridgeState({ capabilities: ALL })),
        scheme,
        host(<DeviceManager />),
      ),
    ready: "[data-polaris-device-rename]",
    primary: "[data-polaris-device-rename]",
  },
  {
    id: "device-manager.rename",
    render: (scheme) =>
      provider(
        adapterFor(okBridgeState({ capabilities: ALL })),
        scheme,
        host(<DeviceManager />),
      ),
    act: async (root) => {
      root
        .querySelector<HTMLButtonElement>(
          `[data-polaris-device-rename="${roster[0]!.id}"]`,
        )!
        .click();
    },
    before: "[data-polaris-device-rename]",
    ready: "[data-polaris-device-input]",
    primary: '[data-polaris-device-rename-form] button[type="submit"]',
    focus: "[data-polaris-device-input]",
  },
  {
    id: "config-panel",
    render: (scheme) =>
      provider(
        adapterFor(
          okBridgeState({
            capabilities: ALL,
            config: {
              "audio.sampleRate": entry("enforced", 48000),
              "export.defaultFormat": entry("default", "wav-24bit"),
              "ui.theme": entry("default", "system"),
            },
          }),
        ),
        scheme,
        host(<ConfigPanel onOverride={() => undefined} />),
      ),
    ready: "[data-polaris-config-input]",
    // Each row carries its own action; the title check covers the panel.
    primary: null,
  },
  {
    id: "polaris-logout",
    render: (scheme) =>
      provider(
        adapterFor(okBridgeState({ capabilities: ALL })),
        scheme,
        host(<PolarisLogout />),
      ),
    ready: "[data-polaris-logout]",
    primary: "[data-polaris-logout]",
  },
];

/** "system" with the OS dark on a host page that paints nothing and opts in to no dark
 *  scheme: the white canvas decides, so the kit is light. */
export const SYSTEM_ON_LIGHT_HOST: Scene = {
  id: "system-on-light-host",
  render: () =>
    provider(
      adapterFor(okBridgeState({ capabilities: ALL })),
      "system",
      host(
        <>
          <PolarisLogout />
          <div style={{ height: "1rem" }} />
          <DeviceManager />
        </>,
      ),
    ),
  ready: "[data-polaris-device-rename]",
  primary: "[data-polaris-logout]",
};

/** The scenes the preset axis runs (the brand and a host's own font and accent). */
export const PRESET_SCENE_IDS = [
  "license-gate.login",
  "signin-handoff",
  "license-gate.revoked",
  "license-gate.device-limit",
  "license-gate.expired",
  "update-prompt.dialog",
  "device-manager",
];
