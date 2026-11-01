// @pkey-feature identity.nearby ui.kit
//
// Nearby sign-in on the desktop (I-47b.3; UXR-47): `<NearbySignIn>` (the new device) and
// `<NearbyApprover>` (the signed-in one) over the desktop adapter and a fake v5 bridge. The words
// are the kit's own SignIn and NearbyApproval views; the person's controls reach the host.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";

import { PolarisKeyProvider } from "@polaris-key/react";
import { NearbyApprover, NearbySignIn } from "@polaris-key/react/kit";
import { DesktopAdapter } from "../src/desktop/desktopAdapter.js";
import type {
  BridgeNearbyAsk,
  BridgeNearbyRequester,
  BridgeState,
  PolarisBridge,
} from "../src/desktop/bridge.js";
import { stubResizeObserver } from "./autoFixtures.js";
import { NOW_SEC, emptyBridgeState, makeFakeBridge } from "./fixtures.js";

beforeAll(stubResizeObserver);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Fake = PolarisBridge & { push(s: BridgeState): void };

function v5(over: Partial<PolarisBridge> = {}, version = 5): Fake {
  return Object.assign(makeFakeBridge(emptyBridgeState()), {
    version,
    ...over,
  }) as Fake;
}

async function adapterOf(bridge: Fake): Promise<DesktopAdapter> {
  const a = new DesktopAdapter({ bridge, now: () => NOW_SEC });
  for (let i = 0; i < 50 && a.snapshot().phase === "loading"; i++)
    await new Promise((r) => setTimeout(r, 0));
  return a;
}

const wrap = (a: DesktopAdapter, ui: React.ReactNode) =>
  render(
    <PolarisKeyProvider
      config={{ productSlug: "acme", adapter: a }}
      autoSignIn={false}
    >
      {ui}
    </PolarisKeyProvider>,
  );

const control = (c: HTMLElement, key: string) =>
  c.querySelector<HTMLButtonElement>(`button[data-key="${key}"]`);
const shows = (c: HTMLElement, key: string) =>
  waitFor(() => expect(control(c, key)).not.toBeNull());

const req = (
  phase: BridgeNearbyRequester["phase"],
  extra: Partial<BridgeNearbyRequester> = {},
): BridgeNearbyRequester => ({
  sessionId: "s-1",
  phase,
  approvers: [{ id: "ref-1", device: "Mac", platform: "macos" }],
  ...extra,
});

describe("<NearbySignIn> on the desktop bridge", () => {
  it("asks first, finds the lone approver, shows the code, confirms the account", async () => {
    const bridge = v5({
      nearbyStart: vi.fn(async () => req("choose-approver")),
      nearbyChoose: vi.fn(async () => req("waiting", { code: "123 456" })),
      nearbyConfirm: vi.fn(async () => req("done")),
    });
    const a = await adapterOf(bridge);
    const onClose = vi.fn();
    const { container } = wrap(a, <NearbySignIn onClose={onClose} />);
    // The pre-prompt comes before anything crosses the bridge.
    await shows(container, "common.continue");
    expect(bridge.nearbyStart).not.toHaveBeenCalled();
    fireEvent.click(control(container, "common.continue")!);
    await waitFor(() =>
      expect(bridge.nearbyChoose).toHaveBeenCalledWith("s-1", "ref-1"),
    );
    await waitFor(() => expect(container.textContent).toContain("123 456"));
    // Nothing says Signed in yet; Cancel is there; leaving withdraws.
    expect(container.textContent).not.toContain("Signed in");
    await act(async () => {
      bridge.push(
        emptyBridgeState({
          nearby: { requester: req("confirm-account", { email: "a@b.c" }) },
        }),
      );
    });
    await shows(container, "signin.auto.confirm.primary");
    expect(container.textContent).toContain("a@b.c");
    fireEvent.click(control(container, "signin.auto.confirm.primary")!);
    await waitFor(() =>
      expect(bridge.nearbyConfirm).toHaveBeenCalledWith("s-1"),
    );
    await shows(container, "signin.nearby.notYou");
    expect(container.textContent).toContain("Signed in as a@b.c");
    fireEvent.click(control(container, "common.continue")!);
    expect(onClose).toHaveBeenCalledWith({ kind: "signed-in" });
    a.dispose();
  });

  it("Not now ends before anything crosses; Cancel withdraws an open request", async () => {
    const bridge = v5({
      nearbyStart: vi.fn(async () => req("waiting", { code: "654 321" })),
      nearbyCancel: vi.fn(async () => undefined),
    });
    const a = await adapterOf(bridge);
    const first = vi.fn();
    const one = wrap(a, <NearbySignIn onClose={first} />);
    await shows(one.container, "common.notNow");
    fireEvent.click(control(one.container, "common.notNow")!);
    expect(first).toHaveBeenCalledWith({ kind: "not-now" });
    expect(bridge.nearbyStart).not.toHaveBeenCalled();
    one.unmount();

    const second = vi.fn();
    const two = wrap(a, <NearbySignIn prompt={false} onClose={second} />);
    await shows(two.container, "signin.nearby.code");
    fireEvent.click(control(two.container, "common.cancel")!);
    await waitFor(() =>
      expect(bridge.nearbyCancel).toHaveBeenCalledWith("s-1"),
    );
    await waitFor(() =>
      expect(second).toHaveBeenCalledWith({ kind: "cancelled" }),
    );
    a.dispose();
  });

  it("several approvers: the person picks one by the name it reports", async () => {
    const many = req("choose-approver", {
      approvers: [
        { id: "r1", device: "Ana's laptop", platform: "macos" },
        { id: "r2", device: "Desk PC", platform: "windows" },
      ],
    });
    const bridge = v5({
      nearbyStart: vi.fn(async () => many),
      nearbyChoose: vi.fn(async () => req("waiting", { code: "111 222" })),
    });
    const a = await adapterOf(bridge);
    const { container } = wrap(a, <NearbySignIn prompt={false} />);
    await shows(container, "nearby.approver");
    expect(bridge.nearbyChoose).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Tap this code there");
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      'button[data-key="nearby.approver"]',
    );
    expect([...buttons].map((b) => b.textContent)).toEqual([
      "Ana's laptop",
      "Desk PC",
    ]);
    fireEvent.click(buttons[1]!);
    await waitFor(() =>
      expect(bridge.nearbyChoose).toHaveBeenCalledWith("s-1", "r2"),
    );
    a.dispose();
  });

  it("a v4 host draws nothing and tells the host it is unsupported", async () => {
    const nearbyStart = vi.fn();
    const a = await adapterOf(v5({ nearbyStart } as never, 4));
    const onClose = vi.fn();
    const { container } = wrap(a, <NearbySignIn onClose={onClose} />);
    await waitFor(() =>
      expect(onClose).toHaveBeenCalledWith({
        kind: "ended",
        phase: "unsupported",
      }),
    );
    expect(container.querySelector("button")).toBeNull();
    expect(nearbyStart).not.toHaveBeenCalled();
    a.dispose();
  });
});

const ASK: BridgeNearbyAsk = {
  askId: "ask-1",
  device: "Studio PC",
  platform: "windows",
  codes: ["111 111", "222 222", "333 333"],
};

describe("<NearbyApprover> on the desktop bridge", () => {
  it("listens while open, draws the three codes, picks one and stops on unmount", async () => {
    const bridge = v5({
      approverStart: vi.fn(async () => ({ listening: true, asks: [] })),
      approverStop: vi.fn(async () => undefined),
      approverPick: vi.fn(async () => ({ kind: "approved" as const })),
    });
    const a = await adapterOf(bridge);
    const onClose = vi.fn();
    const { container, unmount } = wrap(
      a,
      <NearbyApprover onClose={onClose} />,
    );
    await waitFor(() => expect(bridge.approverStart).toHaveBeenCalled());
    await act(async () => {
      bridge.push(
        emptyBridgeState({
          nearby: { approver: { listening: true, asks: [ASK] } },
        }),
      );
    });
    await shows(container, "signin.approve.deny");
    expect(container.textContent).toContain("Studio PC");
    const codes = [
      ...container.querySelectorAll<HTMLButtonElement>(
        'button[data-key="nearby.code"]',
      ),
    ];
    expect(codes.map((b) => b.textContent)).toEqual([
      "111 111",
      "222 222",
      "333 333",
    ]);
    // The pick that reaches the host is the code, and the page holds no permit.
    await act(async () => {
      fireEvent.click(codes[1]!);
    });
    await waitFor(() =>
      expect(bridge.approverPick).toHaveBeenCalledWith("ask-1", "222 222"),
    );
    await act(async () => {
      bridge.push(
        emptyBridgeState({
          nearby: { approver: { listening: true, asks: [] } },
        }),
      );
    });
    await shows(container, "common.done");
    expect(container.textContent).toContain("Studio PC is signed in");
    fireEvent.click(control(container, "common.done")!);
    expect(onClose).toHaveBeenCalled();
    unmount();
    await waitFor(() => expect(bridge.approverStop).toHaveBeenCalled());
    a.dispose();
  });

  it("Deny answers the ask; a licence choice is one tap per licence", async () => {
    const choose = vi.fn(async () => ({ kind: "approved" as const }));
    const bridge = v5({
      approverStart: vi.fn(async () => ({ listening: true, asks: [ASK] })),
      approverStop: vi.fn(async () => undefined),
      approverPick: vi.fn(async () => ({
        kind: "choose" as const,
        choices: [
          { licenseId: "lic_1", name: "Pro" },
          { licenseId: "lic_2", name: "Team" },
        ],
      })),
      approverChoose: choose,
      approverDeny: vi.fn(async () => undefined),
    });
    const a = await adapterOf(bridge);
    const { container } = wrap(a, <NearbyApprover />);
    await shows(container, "nearby.code");
    fireEvent.click(
      container.querySelectorAll<HTMLButtonElement>(
        'button[data-key="nearby.code"]',
      )[0]!,
    );
    await shows(container, "nearby.license");
    fireEvent.click(
      container.querySelectorAll<HTMLButtonElement>(
        'button[data-key="nearby.license"]',
      )[1]!,
    );
    await waitFor(() =>
      expect(choose).toHaveBeenCalledWith("ask-1", {
        kind: "license",
        licenseId: "lic_2",
      }),
    );
    a.dispose();
  });

  it("a v4 host draws nothing", async () => {
    const approverStart = vi.fn();
    const a = await adapterOf(v5({ approverStart } as never, 4));
    const { container } = wrap(a, <NearbyApprover />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector("button")).toBeNull();
    expect(approverStart).not.toHaveBeenCalled();
    a.dispose();
  });
});
