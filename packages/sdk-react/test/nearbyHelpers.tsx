// Helpers shared by the nearby kit tests: a fake v5 bridge, an adapter over it, the provider.
import { vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { expect } from "vitest";

import { PolarisKeyProvider } from "@polaris-key/react";
import { NearbyApprover, NearbySignIn } from "@polaris-key/react/kit";
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

// Pay the cold first-render cost (module init, component compile, the copy table's first lookups)
// before any test's own 1 s wait starts. Call it from `beforeAll`; it is outside every test's timing.
export async function warmUpNearby(): Promise<void> {
  const bridge = v5({
    nearbyStart: vi.fn(async () => req("choose-approver")),
    nearbyCancel: vi.fn(async () => undefined),
    approverStart: vi.fn(async () => ({ listening: true, asks: [] })),
    approverStop: vi.fn(async () => undefined),
  });
  const a = await adapterOf(bridge);
  const patient = { timeout: 8000 };
  const signIn = wrap(a, <NearbySignIn settleMs={0} />);
  await waitFor(
    () => expect(control(signIn.container, "common.continue")).not.toBeNull(),
    patient,
  );
  cleanup();
  const approver = wrap(a, <NearbyApprover />);
  await waitFor(() => expect(bridge.approverStart).toHaveBeenCalled(), patient);
  await act(async () => {
    bridge.push(
      emptyBridgeState({
        nearby: {
          approver: {
            listening: true,
            asks: [
              {
                askId: "warm-1",
                device: "Warm-up PC",
                platform: "windows",
                codes: ["111 111", "222 222", "333 333"],
              },
            ],
          },
        },
      }),
    );
  });
  await waitFor(
    () =>
      expect(control(approver.container, "signin.approve.deny")).not.toBeNull(),
    patient,
  );
  cleanup();
}
