// Helpers shared by the nearby kit tests: a fake v5 bridge, an adapter over it, the provider.
import { vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { expect } from "vitest";

import { PolarisKeyProvider } from "@polaris-key/react";
import { DesktopAdapter } from "../src/desktop/desktopAdapter.js";
import type {
  BridgeNearbyRequester,
  BridgeState,
  PolarisBridge,
} from "../src/desktop/bridge.js";
import { NOW_SEC, emptyBridgeState, makeFakeBridge } from "./fixtures.js";

export type Fake = PolarisBridge & { push(s: BridgeState): void };

export function v5(over: Partial<PolarisBridge> = {}, version = 5): Fake {
  return Object.assign(makeFakeBridge(emptyBridgeState()), {
    version,
    ...over,
  }) as Fake;
}

export async function adapterOf(bridge: Fake): Promise<DesktopAdapter> {
  const a = new DesktopAdapter({ bridge, now: () => NOW_SEC });
  for (let i = 0; i < 50 && a.snapshot().phase === "loading"; i++)
    await new Promise((r) => setTimeout(r, 0));
  return a;
}

export const wrap = (
  a: DesktopAdapter,
  ui: React.ReactNode,
): ReturnType<typeof render> =>
  render(
    <PolarisKeyProvider
      config={{ productSlug: "acme", adapter: a }}
      autoSignIn={false}
    >
      {ui}
    </PolarisKeyProvider>,
  );

export const control = (c: HTMLElement, key: string) =>
  c.querySelector<HTMLButtonElement>(`button[data-key="${key}"]`);
export const shows = (c: HTMLElement, key: string) =>
  waitFor(() => expect(control(c, key)).not.toBeNull());

export const req = (
  phase: BridgeNearbyRequester["phase"],
  extra: Partial<BridgeNearbyRequester> = {},
): BridgeNearbyRequester => ({
  sessionId: "s-1",
  phase,
  approvers: [{ id: "ref-1", device: "Mac", platform: "macos" }],
  ...extra,
});
