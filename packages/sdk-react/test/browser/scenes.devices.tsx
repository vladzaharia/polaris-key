// DeviceManager scenes for the responsive suite: the states beyond the list (empty, unsupported,
// a failed load, a failed removal, a long list). Built on scenes.tsx's helpers;
// responsive.browser.test.tsx runs them with every other scene. scenes.tsx keeps the list
// itself (device-manager), its open rename (device-manager.rename) and settings (config-panel).

import { DeviceManager } from "../../src/components/DeviceManager.js";
import { PolarisError } from "../../src/core/index.js";
import { okBridgeState } from "../fixtures.js";
import { ALL, MANAGE, adapterFor, host, provider, roster } from "./scenes.js";
import type { Scene } from "./scenes.js";

/** Wait for `selector` under `root`. */
async function until(
  root: HTMLElement,
  selector: string,
): Promise<HTMLElement> {
  const start = performance.now();
  for (;;) {
    const el = root.querySelector<HTMLElement>(selector);
    if (el) return el;
    if (performance.now() - start > 5_000)
      throw new Error(`timed out waiting for ${selector}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const PLATFORMS = ["macos", "windows", "ipados", "linux", "ios", "android"];

/** Twelve devices, a few of them unnamed, last seen over the past weeks. */
const twelve = Array.from({ length: 12 }, (_, i) => ({
  id: `dev_${(i + 1).toString(36).padStart(2, "0")}Q8nB2xVc${i}`,
  current: i === 0,
  status: "ok",
  label: i % 4 === 3 ? null : `Studio machine ${i + 1}`,
  platform: PLATFORMS[i % PLATFORMS.length],
  lastVerifiedAt: Math.floor(Date.now() / 1000) - i * 86_400 * 2,
}));

const other = roster[1]!.id;

export const DEVICE_SCENES: Scene[] = [
  {
    id: "device-manager.empty",
    render: (scheme) =>
      provider(
        adapterFor(okBridgeState({ capabilities: ALL }), (bridge) => {
          bridge.invoke = (async (service: string, method: string) =>
            service === "devices" && method === "list"
              ? []
              : undefined) as never;
        }),
        scheme,
        host(<DeviceManager />),
      ),
    ready: '[data-polaris-devices="empty"]',
    primary: null,
  },
  {
    // A transport that cannot manage devices (a browser cookie session, an old desktop bridge):
    // this device, and where to manage the rest.
    id: "device-manager.unsupported",
    render: (scheme) =>
      provider(
        adapterFor(okBridgeState({ capabilities: ALL }), (bridge) => {
          delete (bridge as { invoke?: unknown }).invoke;
        }),
        scheme,
        host(<DeviceManager manageUrl={MANAGE} />),
      ),
    ready: '[data-polaris-devices="partial"]',
    primary: "[data-polaris-devices-manage]",
  },
  {
    id: "device-manager.load-error",
    render: (scheme) =>
      provider(
        adapterFor(okBridgeState({ capabilities: ALL }), (bridge) => {
          bridge.invoke = (async () => {
            throw new PolarisError("network", "fetch failed");
          }) as never;
        }),
        scheme,
        host(<DeviceManager />),
      ),
    ready: '[data-polaris-devices="error"]',
    primary: "[data-polaris-devices-retry]",
  },
  {
    // A removal the service refused: the sentence sits inside the row it was for.
    id: "device-manager.action-error",
    render: (scheme) =>
      provider(
        adapterFor(okBridgeState({ capabilities: ALL }), (bridge) => {
          bridge.invoke = (async (service: string, method: string) => {
            if (service !== "devices") return undefined;
            if (method === "deauthorize")
              throw new PolarisError("unknown", "HTTP 500 from /devices");
            return method === "list" ? roster : undefined;
          }) as never;
        }),
        scheme,
        host(<DeviceManager />),
      ),
    before: `[data-polaris-device-disconnect="${other}"]`,
    act: async (root) => {
      root
        .querySelector<HTMLButtonElement>(
          `[data-polaris-device-disconnect="${other}"]`,
        )!
        .click();
      (
        await until(root, `[data-polaris-device-confirm-remove="${other}"]`)
      ).click();
    },
    ready: `[data-polaris-device-error="${other}"]`,
    primary: null,
  },
  {
    id: "device-manager.long",
    render: (scheme) =>
      provider(
        adapterFor(okBridgeState({ capabilities: ALL }), (bridge) => {
          bridge.invoke = (async (service: string, method: string) =>
            service === "devices" && method === "list"
              ? twelve
              : undefined) as never;
        }),
        scheme,
        host(<DeviceManager />),
      ),
    ready: "[data-polaris-device-rename]",
    primary: "[data-polaris-device-rename]",
  },
];
