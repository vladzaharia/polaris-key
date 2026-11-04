// @pkey-feature identity.nearby ui.kit
//
// The built UX review's fixes for nearby sign-in on the desktop (UXR-47b): every ending has a
// screen, several approvers are listed and the chosen one named, the approver has a screen of its
// own and says why it stopped, and focus and Escape follow each step.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";

import { NearbyApprover, NearbySignIn } from "@polaris-key/react/kit";
import type {
  BridgeNearbyAsk,
  BridgeNearbyRequester,
  BridgeState,
  PolarisBridge,
} from "../src/desktop/bridge.js";
import { stubResizeObserver } from "./autoFixtures.js";
import { NOW_SEC, emptyBridgeState } from "./fixtures.js";
import { DesktopAdapter } from "../src/desktop/desktopAdapter.js";
import {
  adapterOf,
  control,
  req,
  shows,
  v5,
  wrap,
  type Fake,
} from "./nearbyHelpers.js";

beforeAll(stubResizeObserver);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ASK: BridgeNearbyAsk = {
  askId: "ask-1",
  device: "Studio PC",
  platform: "windows",
  codes: ["111 111", "222 222", "333 333"],
};

const text = (c: HTMLElement) => c.textContent ?? "";
const title = (c: HTMLElement) =>
  c.querySelector<HTMLElement>('[data-part="title"]');

describe("<NearbySignIn> endings and choices", () => {
  it.each([
    ["denied", "Sign-in declined"],
    ["expired", "Code expired"],
    ["not-nearby", "Not nearby"],
    ["rate-limited", "Too many attempts"],
  ] as const)(
    "%s draws its own screen, with Try again and a code",
    async (phase, heading) => {
      const bridge = v5({
        nearbyStart: vi.fn(async () => req("waiting", { code: "111 222" })),
      });
      const a = await adapterOf(bridge);
      const onClose = vi.fn();
      const { container } = wrap(
        a,
        <NearbySignIn prompt={false} onClose={onClose} />,
      );
      await waitFor(() => expect(text(container)).toContain("111 222"));
      await act(async () => {
        bridge.push(emptyBridgeState({ nearby: { requester: req(phase) } }));
      });
      await shows(container, "common.tryAgain");
      expect(title(container)?.textContent).toBe(heading);
      expect(control(container, "signin.nearby.code")).not.toBeNull();
      expect(onClose).toHaveBeenCalledWith({ kind: "ended", phase });
      a.dispose();
    },
  );

  it("Try again asks anew", async () => {
    const start = vi.fn(async () => req("waiting", { code: "111 222" }));
    const bridge = v5({ nearbyStart: start, nearbyCancel: vi.fn() });
    const a = await adapterOf(bridge);
    const { container } = wrap(a, <NearbySignIn prompt={false} />);
    await waitFor(() => expect(text(container)).toContain("111 222"));
    await act(async () => {
      bridge.push(emptyBridgeState({ nearby: { requester: req("denied") } }));
    });
    await shows(container, "common.tryAgain");
    fireEvent.click(control(container, "common.tryAgain")!);
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    a.dispose();
  });

  it("a start that fails draws the connection problem, not a waiting screen", async () => {
    const bridge = v5({
      nearbyStart: vi.fn(async () => {
        throw new Error("down");
      }),
    });
    const a = await adapterOf(bridge);
    const onClose = vi.fn();
    const { container } = wrap(
      a,
      <NearbySignIn prompt={false} onClose={onClose} />,
    );
    await shows(container, "common.tryAgain");
    expect(title(container)?.textContent).toBe("Can't connect");
    expect(onClose).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "failed" }),
    );
    a.dispose();
  });

  it("Cancel draws Not signed in; another window taking the request does too", async () => {
    const bridge = v5({
      nearbyStart: vi.fn(async () => req("waiting", { code: "111 222" })),
      nearbyCancel: vi.fn(async () => undefined),
    });
    const a = await adapterOf(bridge);
    const { container } = wrap(a, <NearbySignIn prompt={false} />);
    await shows(container, "common.cancel");
    fireEvent.click(control(container, "common.cancel")!);
    await shows(container, "common.tryAgain");
    expect(title(container)?.textContent).toBe("Not signed in");
    a.dispose();

    const b = v5({
      nearbyStart: vi.fn(async () => req("waiting", { code: "333 444" })),
    });
    const a2 = await adapterOf(b);
    const two = wrap(a2, <NearbySignIn prompt={false} />);
    await waitFor(() => expect(text(two.container)).toContain("333 444"));
    await act(async () => {
      b.push(emptyBridgeState({}));
    });
    await shows(two.container, "common.tryAgain");
    expect(title(two.container)?.textContent).toBe("Not signed in");
    a2.dispose();
  });

  it("several approvers are listed and never picked silently; the chosen one is named", async () => {
    const many = req("choose-approver", {
      approvers: [
        { id: "r1", device: "Ana's laptop", platform: "macos" },
        { id: "r2", device: null, platform: "windows" },
      ],
    });
    const bridge = v5({
      nearbyStart: vi.fn(async () => many),
      nearbyChoose: vi.fn(async () => req("waiting", { code: "111 222" })),
    });
    const a = await adapterOf(bridge);
    const { container } = wrap(a, <NearbySignIn prompt={false} settleMs={0} />);
    await shows(container, "nearby.approver");
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.nearbyChoose).not.toHaveBeenCalled();
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        'button[data-key="nearby.approver"]',
      )!,
    );
    await waitFor(() => expect(text(container)).toContain("111 222"));
    expect(text(container)).toContain("Open this app on Ana's laptop.");
    expect(control(container, "signin.nearby.another")).not.toBeNull();
    a.dispose();
  });

  it("a lone approver waits for the browse to settle", async () => {
    const bridge = v5({
      nearbyStart: vi.fn(async () => req("choose-approver")),
      nearbyChoose: vi.fn(async () => req("waiting", { code: "123 456" })),
    });
    const a = await adapterOf(bridge);
    const { container } = wrap(
      a,
      <NearbySignIn prompt={false} settleMs={150} />,
    );
    await waitFor(() => expect(bridge.nearbyStart).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 40));
    expect(bridge.nearbyChoose).not.toHaveBeenCalled();
    await waitFor(() => expect(bridge.nearbyChoose).toHaveBeenCalled());
    a.dispose();
    void container;
  });

  it("no device after a while: says so and offers Try again", async () => {
    const bridge = v5({
      nearbyStart: vi.fn(async () => req("searching", { approvers: [] })),
      nearbyCancel: vi.fn(async () => undefined),
    });
    const a = await adapterOf(bridge);
    const { container } = wrap(
      a,
      <NearbySignIn prompt={false} noneFoundMs={60} />,
    );
    await waitFor(() => expect(text(container)).toContain("Looking for"));
    await shows(container, "common.tryAgain");
    expect(title(container)?.textContent).toBe("No device found");
    expect(text(container)).toContain("Approve a Nearby Device");
    a.dispose();
  });

  it("the done step does not ask Not you? a second time, and takes focus", async () => {
    const bridge = v5({
      nearbyStart: vi.fn(async () =>
        req("confirm-account", { email: "a@b.c" }),
      ),
      nearbyConfirm: vi.fn(async () => req("done")),
    });
    const a = await adapterOf(bridge);
    const { container } = wrap(a, <NearbySignIn prompt={false} />);
    await shows(container, "signin.auto.confirm.primary");
    fireEvent.click(control(container, "signin.auto.confirm.primary")!);
    await waitFor(() =>
      expect(text(container)).toContain("Signed in as a@b.c"),
    );
    expect(control(container, "signin.nearby.notYou")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(title(container)));
    a.dispose();
  });

  it("Escape works with focus on the page", async () => {
    const bridge = v5({
      nearbyStart: vi.fn(async () => req("waiting", { code: "111 222" })),
      nearbyCancel: vi.fn(async () => undefined),
    });
    const a = await adapterOf(bridge);
    const onClose = vi.fn();
    const { container } = wrap(
      a,
      <NearbySignIn prompt={false} onClose={onClose} />,
    );
    await waitFor(() => expect(text(container)).toContain("111 222"));
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(onClose).toHaveBeenCalledWith({ kind: "cancelled" }),
    );
    a.dispose();
  });

  it("a fresh mount waits for the host before it decides", async () => {
    const bridge = v5({
      nearbyStart: vi.fn(async () => req("waiting", { code: "555 666" })),
    });
    const a = new DesktopAdapter({ bridge, now: () => NOW_SEC });
    const onClose = vi.fn();
    const { container } = wrap(
      a,
      <NearbySignIn prompt={false} onClose={onClose} />,
    );
    await waitFor(() => expect(text(container)).toContain("555 666"));
    expect(onClose).not.toHaveBeenCalled();
    a.dispose();
  });
});

describe("<NearbyApprover> screens", () => {
  const start = (over: Partial<PolarisBridge> = {}) =>
    v5({
      approverStart: vi.fn(async () => ({ listening: true, asks: [] })),
      approverStop: vi.fn(async () => undefined),
      ...over,
    });
  const push = async (b: Fake, approver: object) => {
    await waitFor(() => expect(b.approverStart).toHaveBeenCalled());
    await act(async () => {
      b.push(emptyBridgeState({ nearby: { approver } as never }));
    });
  };

  it("waiting for a request is a screen: heading, status line, a way out", async () => {
    const bridge = start();
    const a = await adapterOf(bridge);
    const onClose = vi.fn();
    const { container } = wrap(a, <NearbyApprover onClose={onClose} />);
    await shows(container, "common.done");
    expect(title(container)?.textContent).toBe("Approve a Nearby Device");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    a.dispose();
  });

  it("without a host handler there is no dead Done", async () => {
    const a = await adapterOf(start());
    const { container } = wrap(a, <NearbyApprover />);
    await waitFor(() => expect(title(container)).not.toBeNull());
    expect(control(container, "common.done")).toBeNull();
    a.dispose();
  });

  it("an ask whose requester left says so", async () => {
    const bridge = start();
    const a = await adapterOf(bridge);
    const { container } = wrap(a, <NearbyApprover onClose={() => {}} />);
    await push(bridge, { listening: true, asks: [ASK] });
    await shows(container, "nearby.code");
    await push(bridge, { listening: true, asks: [] });
    await waitFor(() =>
      expect(title(container)?.textContent).toBe("Code expired"),
    );
    expect(text(container)).toContain("Studio PC");
    a.dispose();
  });

  it("after the advert stops it says so and Start again listens again", async () => {
    const approverStart = vi
      .fn()
      .mockResolvedValueOnce({ listening: true, asks: [] })
      .mockResolvedValueOnce({ listening: true, asks: [] });
    const bridge = start({ approverStart });
    const a = await adapterOf(bridge);
    const { container } = wrap(a, <NearbyApprover onClose={() => {}} />);
    await waitFor(() => expect(approverStart).toHaveBeenCalledTimes(1));
    await push(bridge, { listening: false, stopped: "budget", asks: [] });
    await shows(container, "signin.nearby.startAgain");
    expect(title(container)?.textContent).toBe("Approvals paused");
    fireEvent.click(control(container, "signin.nearby.startAgain")!);
    await waitFor(() => expect(approverStart).toHaveBeenCalledTimes(2));
    a.dispose();
  });

  it("a new ask replaces a finished outcome", async () => {
    const bridge = start({
      approverPick: vi.fn(async () => ({ kind: "approved" as const })),
    });
    const a = await adapterOf(bridge);
    const { container } = wrap(a, <NearbyApprover onClose={() => {}} />);
    await push(bridge, { listening: true, asks: [ASK] });
    await shows(container, "nearby.code");
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        'button[data-key="nearby.code"]',
      )!,
    );
    await waitFor(() =>
      expect(text(container)).toContain("Studio PC is signed in"),
    );
    await push(bridge, {
      listening: true,
      asks: [{ ...ASK, askId: "ask-2", device: "Second PC" }],
    });
    await waitFor(() => expect(text(container)).toContain("Second PC"));
    expect(control(container, "nearby.code")).not.toBeNull();
    a.dispose();
  });

  it("a failed answer is a connection problem, not an expired code", async () => {
    const bridge = start({
      approverPick: vi.fn(async () => ({ kind: "failed" as const })),
    });
    const a = await adapterOf(bridge);
    const { container } = wrap(a, <NearbyApprover onClose={() => {}} />);
    await push(bridge, { listening: true, asks: [ASK] });
    await shows(container, "nearby.code");
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        'button[data-key="nearby.code"]',
      )!,
    );
    await waitFor(() =>
      expect(title(container)?.textContent).toBe("Can't connect"),
    );
    expect(text(container)).not.toContain("Code expired");
    a.dispose();
  });

  it("a host that will not start listening says so, with a way out", async () => {
    const bridge = start({
      approverStart: vi.fn(async () => {
        throw new Error("busy");
      }),
    });
    const a = await adapterOf(bridge);
    const onClose = vi.fn();
    const { container } = wrap(a, <NearbyApprover onClose={onClose} />);
    await waitFor(() =>
      expect(title(container)?.textContent).toBe("Can't connect"),
    );
    expect(text(container)).not.toContain("{device}");
    fireEvent.click(control(container, "common.done")!);
    expect(onClose).toHaveBeenCalled();
    a.dispose();
  });

  it("Escape denies a fresh ask with focus on the page", async () => {
    const deny = vi.fn(async () => undefined);
    const bridge = start({ approverDeny: deny });
    const a = await adapterOf(bridge);
    const { container } = wrap(a, <NearbyApprover onClose={() => {}} />);
    await push(bridge, { listening: true, asks: [ASK] });
    await shows(container, "nearby.code");
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(deny).toHaveBeenCalledWith("ask-1"));
    a.dispose();
  });

  it("the ask takes focus when it arrives, and licences are rows in the body face", async () => {
    const bridge = start({
      approverPick: vi.fn(async () => ({
        kind: "choose" as const,
        choices: [{ licenseId: "l1", name: "Ana — Personal" }],
      })),
    });
    const a = await adapterOf(bridge);
    const { container } = wrap(a, <NearbyApprover onClose={() => {}} />);
    await push(bridge, { listening: true, asks: [ASK] });
    await shows(container, "nearby.code");
    await waitFor(() => expect(document.activeElement).toBe(title(container)));
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        'button[data-key="nearby.code"]',
      )!,
    );
    await shows(container, "nearby.license");
    expect(
      control(container, "nearby.license")!.getAttribute("data-nearby"),
    ).toBe("row");
    a.dispose();
  });
});
