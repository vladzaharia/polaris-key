// The drop-in kit's screens as a host page renders them, over the tests' fake desktop bridge: one
// scene per component state the responsive suite measures. The host page sets no font of its
// own, so a scene also shows what the kit does on a bare page.

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
}

const MANAGE =
  "https://key.plrs.im/portal/tidewater-studio-professional-mastering-suite/devices?return=https%3A%2F%2Fexample.com";
const ALL = services("license", "config", "identity", "update");

const roster = [
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

function adapterFor(
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
function host(children: ReactNode): ReactNode {
  return (
    <main style={{ padding: "1rem" }} data-host-content="">
      <h1 style={{ margin: "0 0 1rem" }}>Tidewater Studio</h1>
      {children}
    </main>
  );
}

function provider(
  adapter: PolarisAdapter,
  scheme: Scheme,
  children: ReactNode,
): { node: ReactNode; adapter: PolarisAdapter } {
  return {
    adapter,
    node: (
      <PolarisKeyProvider
        productSlug="tidewater"
        adapter={adapter}
        colorScheme={scheme}
        theme={{ copy: { productName: "Tidewater Studio" } }}
      >
        {children}
      </PolarisKeyProvider>
    ),
  };
}

const app = host(<p>Host app content.</p>);

async function typeKey(root: HTMLElement): Promise<void> {
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

export const SCENES: Scene[] = [
  {
    id: "license-gate.login",
    render: (scheme) =>
      provider(
        adapterFor(emptyBridgeState({ capabilities: ALL })),
        scheme,
        <LicenseGate returnUrl="https://example.com">{app}</LicenseGate>,
      ),
    ready: "[data-polaris-oidc]",
    primary: "[data-polaris-oidc]",
  },
  {
    id: "license-gate.device-limit",
    render: (scheme) =>
      provider(
        adapterFor(emptyBridgeState({ capabilities: ALL }), (bridge) => {
          bridge.submitKey = async () =>
            ({
              kind: "device-limit",
              limit: 3,
              deviceCount: 3,
              manageUrl: MANAGE,
            }) as BridgeActivation;
        }),
        scheme,
        <LicenseGate returnUrl="https://example.com">{app}</LicenseGate>,
      ),
    act: typeKey,
    before: "[data-polaris-key-input]",
    ready: "[data-polaris-free-device]",
    primary: "[data-polaris-free-device]",
  },
  {
    id: "license-gate.error",
    render: (scheme) =>
      provider(
        withManageError(adapterFor(emptyBridgeState({ capabilities: ALL }))),
        scheme,
        <LicenseGate returnUrl="https://example.com">{app}</LicenseGate>,
      ),
    ready: '[data-polaris-gate="error"] [data-polaris-actions]',
    primary: '[data-polaris-gate="error"] [data-polaris-actions] button',
  },
  {
    id: "license-gate.expired",
    render: (scheme) =>
      provider(
        adapterFor(
          okBridgeState({
            capabilities: ALL,
            doc: makeDoc({ issuedAt: 100, expiresAt: 200, graceUntil: 300 }),
          }),
        ),
        scheme,
        <LicenseGate>{app}</LicenseGate>,
      ),
    ready: '[data-polaris-gate="expired"] [data-polaris-oidc]',
    primary: "[data-polaris-oidc]",
  },
  {
    id: "license-gate.version",
    render: (scheme) =>
      provider(
        adapterFor(
          okBridgeState({
            capabilities: ALL,
            blocked: {
              reason: "version-too-old",
              allowedRange: { min: "5.0.0" },
            },
          } as never),
        ),
        scheme,
        <LicenseGate>{app}</LicenseGate>,
      ),
    ready: '[data-polaris-gate="version-block"] button',
    primary: '[data-polaris-gate="version-block"] button',
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
    primary: "[data-polaris-config-input]",
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
