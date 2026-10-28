// @pkey-feature ui.kit sync.keyring
//
// U-42.2: the Cloud Sync screens in the React kit. UnlockSync takes the recovery code only in its
// field and hands it to the ring on the press; a wrong code, a missing one and a failed request
// each have their own way forward; Start over warns first and ends on the new code, shown once;
// RecoveryCode is no input and cannot be left before "I've saved it"; RingChange passes the ring it
// was shown. The matrix rows are kitMatrix's `cloudSync` family.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import type { ReactNode } from "react";

import { PolarisContext } from "../src/react/context.js";
import { kitComponent } from "../src/kit/kitComponent.js";
import {
  RecoveryCode,
  RingChange,
  UnlockSync,
} from "../src/kit/syncScreens.js";
import type {
  KeyringClient,
  RingCode,
  RingStatus,
} from "../src/core/keyring.js";
import { PolarisError } from "../src/core/types.js";
import * as PublicKit from "../src/kit/index.js";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SERVED = { ringId: "ring_9f3a", epoch: 2, rootKid: "kid_b21c" };
const CODE = "ABCD EFGH JKLM NPQR STUV WXYZ 2345 6789";
const unlocked: RingStatus = {
  state: "unlocked",
  ringId: "ring_9f3a",
  epoch: 2,
  recoverySet: true,
  persistence: "memory",
  canCreate: true,
};
const changed: RingStatus = {
  ...unlocked,
  state: "ring-changed",
  changed: {
    pinned: { ...SERVED, epoch: 1 },
    served: SERVED,
    by: "Maya's MacBook",
  },
};

function fakeRing(over: Partial<KeyringClient> = {}): KeyringClient {
  const noop = vi.fn(async () => unlocked);
  return {
    unsupported: null,
    status: vi.fn(async () => unlocked),
    create: vi.fn(),
    recover: noop,
    setRecoveryCode: vi.fn(),
    reset: vi.fn(
      async (): Promise<RingCode> => ({
        recoveryCode: CODE,
        ringId: "ring_new",
        epoch: 3,
      }),
    ),
    adoptPrevious: vi.fn(),
    wrapTo: vi.fn(),
    removeWrap: vi.fn(),
    lock: vi.fn(),
    forget: vi.fn(),
    acceptRingChange: vi.fn(async () => unlocked),
    hasRoot: () => true,
    subscribe: () => () => undefined,
    codec: () => null,
    ...over,
  } as unknown as KeyringClient;
}

function inProvider(ring: KeyringClient, ui: ReactNode): RenderResult {
  const adapter = { keyring: ring } as unknown as never;
  return render(
    <PolarisContext.Provider value={{ adapter }}>{ui}</PolarisContext.Provider>,
  );
}

const control = (c: HTMLElement, key: string) =>
  c.querySelector<HTMLButtonElement>(`button[data-key="${key}"]`);
const field = (c: HTMLElement) =>
  c.querySelector<HTMLInputElement>('[data-key="unlockSync.field"]');
const typeCode = (c: HTMLElement, value: string) =>
  fireEvent.change(field(c)!, { target: { value } });
const saved = (c: HTMLElement) =>
  fireEvent.click(c.querySelector('input[type="checkbox"]')!);

/** The driven UnlockSync over a ring whose `recover` answers `answer`, with `CODE` pressed in. */
async function unlockWith(answer: () => Promise<RingStatus>) {
  const view = inProvider(fakeRing({ recover: vi.fn(answer) }), <UnlockSync />);
  await waitFor(() => expect(field(view.container)).not.toBeNull());
  typeCode(view.container, CODE);
  fireEvent.click(control(view.container, "unlockSync.unlock")!);
  return view.container;
}

describe("UnlockSync (plain part)", () => {
  const Part = kitComponent("UnlockSync");

  it("hands the typed code to the host with the Unlock press, and only then", () => {
    const onAction = vi.fn();
    const onInput = vi.fn();
    const { container } = render(
      <Part
        input={{ unlockSync: { step: "code" } }}
        onAction={onAction}
        onInput={onInput}
      />,
    );
    typeCode(container, "  abcd efgh  ");
    // Editing tells the host that the field changed, never what it holds.
    expect(onInput).toHaveBeenCalledWith("recoveryEdited", "1");
    expect(JSON.stringify(onInput.mock.calls)).not.toContain("abcd");
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(control(container, "unlockSync.unlock")!);
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "unlockSync.unlock",
        action: "unlock",
        value: "abcd efgh",
      }),
    );
  });

  it("offers Start over and the note that nothing asks for the code; no nearby unlock", () => {
    const { container } = render(
      <Part input={{ unlockSync: { step: "code", nearby: true } }} />,
    );
    expect(control(container, "unlockSync.startOver")).not.toBeNull();
    expect(
      container.querySelector('[data-key="recoveryCode.noAsk"]'),
    ).not.toBeNull();
    expect(container.textContent?.toLowerCase()).not.toContain("nearby");
    expect(container.querySelector("h1")).not.toBeNull();
  });

  it("Start over confirms in danger, first, with Cancel last and focused", async () => {
    const { container } = render(
      <Part input={{ unlockSync: { step: "start-over" } }} autoFocus fill />,
    );
    const buttons = [
      ...container.querySelectorAll<HTMLElement>(".actions button"),
    ];
    expect(buttons.map((b) => b.dataset.key)).toEqual([
      "unlockSync.startOverConfirm",
      "common.cancel",
    ]);
    expect(buttons[0]!.dataset.variant).toBe("danger");
    await waitFor(() => expect(document.activeElement).toBe(buttons[1]));
  });

  it("Escape is Cancel", () => {
    const onAction = vi.fn();
    const { container } = render(
      <Part input={{ unlockSync: { step: "code" } }} onAction={onAction} />,
    );
    fireEvent.keyDown(field(container)!, { key: "Escape" });
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ key: "common.cancel" }),
    );
  });
});

describe("UnlockSync (driven)", () => {
  it("unlocks with the typed code, then tells the host", async () => {
    const recover = vi.fn(async () => unlocked);
    const onUnlocked = vi.fn();
    const { container } = inProvider(
      fakeRing({ recover }),
      <UnlockSync onUnlocked={onUnlocked} />,
    );
    await waitFor(() => expect(field(container)).not.toBeNull());
    typeCode(container, CODE);
    fireEvent.click(control(container, "unlockSync.unlock")!);
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
    expect(recover).toHaveBeenCalledWith(CODE);
  });

  it("a wrong code says so, and editing clears it", async () => {
    const container = await unlockWith(async () => {
      throw new PolarisError("recovery-code-invalid", "no");
    });
    await waitFor(() =>
      expect(
        container.querySelector('[data-key="unlockSync.invalid"]'),
      ).not.toBeNull(),
    );
    expect(field(container)!.getAttribute("aria-invalid")).toBe("true");
    typeCode(container, "WRONG2");
    await waitFor(() =>
      expect(
        container.querySelector('[data-key="unlockSync.invalid"]'),
      ).toBeNull(),
    );
  });

  it("an account with no recovery code goes to Start over, not to Try again", async () => {
    const container = await unlockWith(async () => {
      throw new PolarisError("not_found" as never, "none");
    });
    await waitFor(() =>
      expect(control(container, "unlockSync.startOverConfirm")).not.toBeNull(),
    );
    expect(control(container, "common.tryAgain")).toBeNull();
  });

  it("another failure offers Try again, which goes back to the field", async () => {
    const container = await unlockWith(async () => {
      throw new PolarisError("network", "down");
    });
    await waitFor(() =>
      expect(control(container, "common.tryAgain")).not.toBeNull(),
    );
    fireEvent.click(control(container, "common.tryAgain")!);
    await waitFor(() => expect(field(container)).not.toBeNull());
  });

  it("Start over warns, resets, shows the new code once, and Done needs the box", async () => {
    const ring = fakeRing();
    const onUnlocked = vi.fn();
    const { container } = inProvider(
      ring,
      <UnlockSync onUnlocked={onUnlocked} />,
    );
    await waitFor(() => expect(field(container)).not.toBeNull());
    fireEvent.click(control(container, "unlockSync.startOver")!);
    expect(ring.reset).not.toHaveBeenCalled();
    fireEvent.click(control(container, "unlockSync.startOverConfirm")!);
    await waitFor(() =>
      expect(container.querySelector(".recovery-groups")).not.toBeNull(),
    );
    expect(ring.reset).toHaveBeenCalledTimes(1);
    expect(control(container, "common.done")).toBeNull();
    saved(container);
    await waitFor(() =>
      expect(control(container, "common.done")).not.toBeNull(),
    );
    fireEvent.click(control(container, "common.done")!);
    expect(onUnlocked).toHaveBeenCalled();
  });

  it("Cancel on the warning goes back to the field; Cancel on the field leaves", async () => {
    const onCancel = vi.fn();
    const { container } = inProvider(
      fakeRing(),
      <UnlockSync onCancel={onCancel} />,
    );
    await waitFor(() => expect(field(container)).not.toBeNull());
    fireEvent.click(control(container, "unlockSync.startOver")!);
    fireEvent.click(control(container, "common.cancel")!);
    await waitFor(() => expect(field(container)).not.toBeNull());
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(control(container, "common.cancel")!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("RecoveryCode", () => {
  it("draws the code as eight groups of four, never as an input", async () => {
    const { container } = render(<RecoveryCode code={CODE} />);
    await waitFor(() =>
      expect(container.querySelector(".recovery-groups")).not.toBeNull(),
    );
    const groups = [...container.querySelectorAll(".recovery-groups .g")];
    expect(groups.map((g) => g.textContent)).toEqual(CODE.split(" "));
    expect(container.querySelector('input[type="text"]')).toBeNull();
    expect(container.querySelector("[value]")).toBeNull();
    expect(
      container.querySelector('[data-key="recoveryCode.noAsk"]'),
    ).not.toBeNull();
  });

  it("Copy code writes the code; Done waits for the box; Escape does nothing", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const onDone = vi.fn();
    const onAction = vi.fn();
    const { container } = render(
      <RecoveryCode code={CODE} onDone={onDone} onAction={onAction} />,
    );
    await waitFor(() =>
      expect(control(container, "recoveryCode.copy")).not.toBeNull(),
    );
    fireEvent.click(control(container, "recoveryCode.copy")!);
    expect(writeText).toHaveBeenCalledWith(CODE);
    expect(control(container, "common.done")).toBeNull();
    fireEvent.keyDown(container.querySelector(".pk-root")!, { key: "Escape" });
    expect(onDone).not.toHaveBeenCalled();
    saved(container);
    await waitFor(() =>
      expect(control(container, "common.done")).not.toBeNull(),
    );
    fireEvent.click(control(container, "common.done")!);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("RingChange", () => {
  const Part = kitComponent("RingChange");

  it("names the device and passes the ring it was shown to acceptRingChange", async () => {
    const ring = fakeRing({ status: vi.fn(async () => changed) });
    const onAccepted = vi.fn();
    const { container } = inProvider(
      ring,
      <RingChange onAccepted={onAccepted} />,
    );
    await waitFor(() =>
      expect(control(container, "ringChange.accept")).not.toBeNull(),
    );
    expect(container.textContent).toContain("Maya's MacBook");
    fireEvent.click(control(container, "ringChange.accept")!);
    await waitFor(() => expect(onAccepted).toHaveBeenCalled());
    expect(ring.acceptRingChange).toHaveBeenCalledWith(SERVED);
  });

  it("the recovery code is the primary; without a served ring there is no Accept", () => {
    const onAction = vi.fn();
    const { container } = render(
      <Part
        input={{ ringChange: { by: "Maya's MacBook" } }}
        onAction={onAction}
      />,
    );
    expect(control(container, "ringChange.accept")).toBeNull();
    expect(control(container, "ringChange.useCode")!.dataset.variant).toBe(
      "primary",
    );
  });

  it("draws nothing when the ring has not changed", async () => {
    const { container } = inProvider(fakeRing(), <RingChange />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector(".pk-root")).toBeNull();
  });
});

describe("CloudSyncStatus: locked and ring-changed", () => {
  const Status = kitComponent("CloudSyncStatus");
  it("locked offers Unlock sync, never a time; the strip is neutral", () => {
    const { container } = render(
      <Status
        input={{ cloudSync: { state: "locked", lastSynced: "2 min ago" } }}
      />,
    );
    expect(control(container, "cloudSync.unlock")).not.toBeNull();
    expect(container.textContent).not.toContain("2 min");
    expect(
      container.querySelector<HTMLElement>("[data-status]")!.dataset.status,
    ).toBe("neutral");
  });
  it("ring-changed shows Review without a host handler", () => {
    const { container } = render(
      <Status input={{ cloudSync: { state: "ring-changed" } }} />,
    );
    expect(control(container, "common.review")).not.toBeNull();
    expect(control(container, "cloudSync.unlock")).toBeNull();
  });
});

describe("the public exports", () => {
  it("load the screens on demand and draw them", async () => {
    const { container } = render(
      <PublicKit.UnlockSync input={{ unlockSync: { step: "code" } }} />,
    );
    await waitFor(() => expect(field(container)).not.toBeNull());
    cleanup();
    const ring = render(
      <PublicKit.RecoveryCode code={CODE} input={{ recoveryCode: {} }} />,
    );
    await waitFor(() =>
      expect(ring.container.querySelector(".recovery-groups")).not.toBeNull(),
    );
    cleanup();
    const change = render(
      <PublicKit.RingChange input={{ ringChange: { served: SERVED } }} />,
    );
    await waitFor(() =>
      expect(control(change.container, "ringChange.accept")).not.toBeNull(),
    );
  });
});
