// @pkey-feature ui.kit sync.keyring
//
// U-42.2: the Cloud Sync screens in the React kit. UnlockSync takes the recovery code only in its
// field and hands it to the ring on the press; the field keeps its text through every step; a
// wrong code, a missing one and a failed request each have their own way forward; Start over
// warns first, arms after 500 ms and is not cancellable while it runs; RecoveryCode draws a real
// hyphenated code as eight groups, reads it out as an image, and cannot be left before "I've saved
// it"; RingChange passes the ring it was shown, shows progress and a refusal. The matrix rows are
// kitMatrix's `cloudSync` family.

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
import { CloudSyncStatus } from "../src/kit/statusDrive.js";
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
// A real code: eight Crockford groups joined by hyphens, as the engine hands it over.
const CODE = "K7QF-2M9D-XR4T-8WHB-3JNC-6PEZ-V5GD-HT0S";
const GROUPS = CODE.split("-");
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
  return {
    unsupported: null,
    status: vi.fn(async () => unlocked),
    create: vi.fn(),
    recover: vi.fn(async () => unlocked),
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
  c.querySelector<HTMLTextAreaElement>('[data-key="unlockSync.field"]');
const typeCode = (c: HTMLElement, value: string) =>
  fireEvent.change(field(c)!, { target: { value } });
const saved = (c: HTMLElement) =>
  fireEvent.click(c.querySelector('input[type="checkbox"]')!);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keys = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLElement>(".actions button")].map(
    (b) => b.dataset.key,
  );

/** The driven UnlockSync, past the Start over warning's 500 ms, with Start over pressed. */
async function startOverWith(
  ring: KeyringClient,
  ui: ReactNode = <UnlockSync />,
) {
  const { container } = inProvider(ring, ui);
  await waitFor(() => expect(field(container)).not.toBeNull());
  fireEvent.click(control(container, "unlockSync.startOver")!);
  await wait(600);
  fireEvent.click(control(container, "unlockSync.startOverConfirm")!);
  return container;
}

/** A RingChange over a ring that reports a changed ring, with its Accept drawn. */
async function ringChangeWith(over: Partial<KeyringClient>, ui: ReactNode) {
  const ring = fakeRing({ status: vi.fn(async () => changed), ...over });
  const { container } = inProvider(ring, ui);
  await waitFor(() =>
    expect(control(container, "ringChange.accept")).not.toBeNull(),
  );
  return { container, ring };
}

/** The driven UnlockSync over a ring whose `recover` answers `answer`, with `CODE` pressed in. */
async function unlockWith(
  answer: () => Promise<RingStatus>,
  over: Partial<KeyringClient> = {},
  ui: ReactNode = <UnlockSync />,
) {
  const ring = fakeRing({ recover: vi.fn(answer), ...over });
  const view = inProvider(ring, ui);
  await waitFor(() => expect(field(view.container)).not.toBeNull());
  typeCode(view.container, CODE);
  fireEvent.click(control(view.container, "unlockSync.unlock")!);
  return { container: view.container, ring };
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
    typeCode(container, "  abcd   efgh  ");
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

  it("an empty field sends nothing and keeps focus in the field", () => {
    const onAction = vi.fn();
    const { container } = render(
      <Part input={{ unlockSync: { step: "code" } }} onAction={onAction} />,
    );
    fireEvent.click(control(container, "unlockSync.unlock")!);
    expect(onAction).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field(container));
  });

  it("offers Start over and the note that nothing asks for the code; Cancel is quiet; no nearby unlock", () => {
    const { container } = render(
      <Part input={{ unlockSync: { step: "code", nearby: true } }} />,
    );
    expect(control(container, "unlockSync.startOver")).not.toBeNull();
    expect(
      container.querySelector('[data-key="recoveryCode.noAsk"]'),
    ).not.toBeNull();
    expect(control(container, "common.cancel")!.dataset.variant).toBe("link");
    expect(container.textContent?.toLowerCase()).not.toContain("nearby");
    expect(container.querySelector("h1")).not.toBeNull();
  });

  it("keeps the field and its text through every step", () => {
    const view = render(<Part input={{ unlockSync: { step: "code" } }} />);
    const f = field(view.container)!;
    f.value = "k7qf 2m9d";
    for (const step of [
      "working",
      "invalid",
      "failed",
      "start-over",
      "no-code",
      "code",
    ] as const) {
      view.rerender(<Part input={{ unlockSync: { step } }} />);
      expect(field(view.container), step).toBe(f);
      expect(f.value).toBe("k7qf 2m9d");
    }
  });

  it("working keeps the pressed control, busy and focused, with no Cancel", async () => {
    const view = render(
      <Part input={{ unlockSync: { step: "code" } }} fill autoFocus />,
    );
    const unlock = control(view.container, "unlockSync.unlock")!;
    unlock.focus();
    view.rerender(
      <Part input={{ unlockSync: { step: "working" } }} fill autoFocus />,
    );
    expect(control(view.container, "unlockSync.unlock")).toBe(unlock);
    expect(unlock.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(unlock);
    expect(control(view.container, "common.cancel")).toBeNull();
    expect(field(view.container)!.readOnly).toBe(true);
  });

  it("the failure reason sits above the actions", () => {
    const { container } = render(
      <Part input={{ unlockSync: { step: "failed" } }} />,
    );
    const reason = container.querySelector('[data-key="unlockSync.failed"]')!;
    expect(
      reason.compareDocumentPosition(container.querySelector(".actions")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("Start over confirms in danger, first, with Cancel last and focused", async () => {
    const { container } = render(
      <Part input={{ unlockSync: { step: "start-over" } }} autoFocus fill />,
    );
    expect(keys(container)).toEqual([
      "unlockSync.startOverConfirm",
      "common.cancel",
    ]);
    expect(
      control(container, "unlockSync.startOverConfirm")!.dataset.variant,
    ).toBe("danger");
    await waitFor(() =>
      expect(document.activeElement).toBe(control(container, "common.cancel")),
    );
    // The warning is the group's description: a screen reader hears it with the focus.
    const group = container.querySelector(".actions")!;
    expect(group.getAttribute("aria-describedby")).toBe("pk-start-warning");
    expect(container.querySelector("#pk-start-warning")).not.toBeNull();
  });

  it("the Start over confirm takes no press for 500 ms", async () => {
    const onAction = vi.fn();
    const { container } = render(
      <Part
        input={{ unlockSync: { step: "start-over" } }}
        onAction={onAction}
      />,
    );
    const confirm = control(container, "unlockSync.startOverConfirm")!;
    await waitFor(() =>
      expect(confirm.getAttribute("aria-disabled")).toBe("true"),
    );
    fireEvent.click(confirm);
    expect(onAction).not.toHaveBeenCalled();
    await wait(600);
    await waitFor(() =>
      expect(confirm.getAttribute("aria-disabled")).toBeNull(),
    );
    fireEvent.click(confirm);
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ key: "unlockSync.startOverConfirm" }),
    );
  });

  it("Escape is Cancel, except while it works", () => {
    const onAction = vi.fn();
    const view = render(
      <Part input={{ unlockSync: { step: "code" } }} onAction={onAction} />,
    );
    fireEvent.keyDown(field(view.container)!, { key: "Escape" });
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ key: "common.cancel" }),
    );
    onAction.mockClear();
    view.rerender(
      <Part input={{ unlockSync: { step: "working" } }} onAction={onAction} />,
    );
    fireEvent.keyDown(field(view.container)!, { key: "Escape" });
    expect(onAction).not.toHaveBeenCalled();
  });

  it("the no-code step says so and leads with Start over", () => {
    const { container } = render(
      <Part input={{ unlockSync: { step: "no-code" } }} />,
    );
    expect(
      container.querySelector('[data-key="unlockSync.noCode"]'),
    ).not.toBeNull();
    expect(control(container, "unlockSync.startOver")!.dataset.variant).toBe(
      "primary",
    );
  });
});

describe("UnlockSync (driven)", () => {
  it("unlocks with the typed code, then tells the host and leaves the screen", async () => {
    const onUnlocked = vi.fn();
    const { container, ring } = await unlockWith(
      async () => unlocked,
      {},
      <UnlockSync onUnlocked={onUnlocked} />,
    );
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
    expect(ring.recover).toHaveBeenCalledWith(CODE);
    expect(container.querySelector(".pk-root")).toBeNull();
  });

  it("with no host handler it still leaves the working step: it draws nothing once unlocked", async () => {
    const { container } = await unlockWith(async () => unlocked);
    await waitFor(() => expect(container.querySelector(".pk-root")).toBeNull());
  });

  it("a wrong code says so, keeps what was typed, and editing clears the message", async () => {
    const { container } = await unlockWith(async () => {
      throw new PolarisError("recovery-code-invalid", "no");
    });
    await waitFor(() =>
      expect(
        container.querySelector('[data-key="unlockSync.invalid"]'),
      ).not.toBeNull(),
    );
    expect(field(container)!.getAttribute("aria-invalid")).toBe("true");
    expect(field(container)!.value).toBe(CODE);
    typeCode(container, CODE.slice(0, -1));
    await waitFor(() =>
      expect(
        container.querySelector('[data-key="unlockSync.invalid"]'),
      ).toBeNull(),
    );
  });

  it("an account with no recovery code says so and leads with Start over", async () => {
    const { container } = await unlockWith(async () => {
      throw new PolarisError("not_found" as never, "none");
    });
    await waitFor(() =>
      expect(
        container.querySelector('[data-key="unlockSync.noCode"]'),
      ).not.toBeNull(),
    );
    expect(control(container, "common.tryAgain")).toBeNull();
    fireEvent.click(control(container, "unlockSync.startOver")!);
    await waitFor(() =>
      expect(control(container, "unlockSync.startOverConfirm")).not.toBeNull(),
    );
    // Cancel on the warning goes back to what was said, not to the field.
    fireEvent.click(control(container, "common.cancel")!);
    await waitFor(() =>
      expect(
        container.querySelector('[data-key="unlockSync.noCode"]'),
      ).not.toBeNull(),
    );
  });

  it("another failure offers Try again, which returns to the field with its text", async () => {
    const { container } = await unlockWith(async () => {
      throw new PolarisError("network", "down");
    });
    await waitFor(() =>
      expect(control(container, "common.tryAgain")).not.toBeNull(),
    );
    fireEvent.click(control(container, "common.tryAgain")!);
    await waitFor(() =>
      expect(control(container, "unlockSync.unlock")).not.toBeNull(),
    );
    expect(field(container)!.value).toBe(CODE);
  });

  it("Start over warns, arms, resets, shows the new code once, and Done needs the box", async () => {
    const ring = fakeRing();
    const onUnlocked = vi.fn();
    const { container } = inProvider(
      ring,
      <UnlockSync onUnlocked={onUnlocked} />,
    );
    await waitFor(() => expect(field(container)).not.toBeNull());
    fireEvent.click(control(container, "unlockSync.startOver")!);
    // A double-click on Start over does not also confirm it.
    fireEvent.click(control(container, "unlockSync.startOverConfirm")!);
    expect(ring.reset).not.toHaveBeenCalled();
    await wait(600);
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

  it("Start over is not cancellable while it runs: Escape and Cancel are ignored", async () => {
    let finish: (c: RingCode) => void = () => undefined;
    const reset = vi.fn(() => new Promise<RingCode>((r) => (finish = r)));
    const onCancel = vi.fn();
    const container = await startOverWith(
      fakeRing({ reset }),
      <UnlockSync onCancel={onCancel} />,
    );
    await waitFor(() =>
      expect(
        control(container, "unlockSync.startOverConfirm")!.getAttribute(
          "aria-disabled",
        ),
      ).toBe("true"),
    );
    expect(control(container, "common.cancel")).toBeNull();
    fireEvent.keyDown(container.querySelector(".pk-root")!, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    finish({ recoveryCode: CODE, ringId: "r", epoch: 3 });
    await waitFor(() =>
      expect(container.querySelector(".recovery-groups")).not.toBeNull(),
    );
  });

  it("a failed Start over retries Start over, not the unlock", async () => {
    const reset = vi
      .fn<() => Promise<RingCode>>()
      .mockRejectedValueOnce(new PolarisError("network", "down"))
      .mockResolvedValueOnce({ recoveryCode: CODE, ringId: "r", epoch: 3 });
    const container = await startOverWith(fakeRing({ reset }));
    await waitFor(() =>
      expect(control(container, "common.tryAgain")).not.toBeNull(),
    );
    fireEvent.click(control(container, "common.tryAgain")!);
    await waitFor(() =>
      expect(container.querySelector(".recovery-groups")).not.toBeNull(),
    );
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it("an empty field does not call the ring", async () => {
    const ring = fakeRing();
    const { container } = inProvider(ring, <UnlockSync />);
    await waitFor(() => expect(field(container)).not.toBeNull());
    fireEvent.click(control(container, "unlockSync.unlock")!);
    expect(ring.recover).not.toHaveBeenCalled();
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
    await waitFor(() =>
      expect(control(container, "unlockSync.unlock")).not.toBeNull(),
    );
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(control(container, "common.cancel")!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("RecoveryCode", () => {
  it("draws a real hyphenated code as eight groups of four, never as an input", async () => {
    const { container } = render(<RecoveryCode code={CODE} />);
    await waitFor(() =>
      expect(container.querySelector(".recovery-groups")).not.toBeNull(),
    );
    const groups = [...container.querySelectorAll(".recovery-groups .g")];
    expect(groups.map((g) => g.textContent)).toEqual(GROUPS);
    expect(container.querySelector('input[type="text"], textarea')).toBeNull();
    expect(container.querySelector("[value]")).toBeNull();
    expect(
      container.querySelector('[data-key="recoveryCode.noAsk"]'),
    ).not.toBeNull();
  });

  it("normalises spaces, hyphens and case into the same eight groups", async () => {
    const { container } = render(
      <RecoveryCode code={CODE.toLowerCase().replace(/-/g, " ")} />,
    );
    await waitFor(() =>
      expect(container.querySelectorAll(".recovery-groups .g")).toHaveLength(8),
    );
    expect(
      [...container.querySelectorAll(".recovery-groups .g")].map(
        (g) => g.textContent,
      ),
    ).toEqual(GROUPS);
  });

  it("is read out as an image with the groups spelled out, the visible groups hidden", async () => {
    const { container } = render(<RecoveryCode code={CODE} />);
    await waitFor(() =>
      expect(container.querySelector(".recovery-groups")).not.toBeNull(),
    );
    const box = container.querySelector(".recovery-groups")!;
    expect(box.getAttribute("role")).toBe("img");
    expect(box.getAttribute("aria-label")).toContain(
      "K 7 Q F, 2 M 9 D, X R 4 T",
    );
    expect(
      [...box.querySelectorAll(".g")].every(
        (g) => g.getAttribute("aria-hidden") === "true",
      ),
    ).toBe(true);
  });

  it("Copy code writes the hyphenated code and says Copied; Done waits for the box; Escape does nothing", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const onDone = vi.fn();
    const { container } = render(<RecoveryCode code={CODE} onDone={onDone} />);
    await waitFor(() =>
      expect(control(container, "recoveryCode.copy")).not.toBeNull(),
    );
    fireEvent.click(control(container, "recoveryCode.copy")!);
    expect(writeText).toHaveBeenCalledWith(CODE);
    await waitFor(() =>
      expect(control(container, "recoveryCode.copy")!.textContent).toContain(
        "Copied",
      ),
    );
    expect(control(container, "common.done")).toBeNull();
    fireEvent.keyDown(container.querySelector(".pk-root")!, { key: "Escape" });
    expect(onDone).not.toHaveBeenCalled();
    saved(container);
    await waitFor(() =>
      expect(control(container, "common.done")).not.toBeNull(),
    );
    // Checking the box leaves focus on it: Done is not under a second Space.
    expect(document.activeElement).not.toBe(control(container, "common.done"));
    fireEvent.click(control(container, "common.done")!);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("RingChange", () => {
  const Part = kitComponent("RingChange");

  it("names the device and passes the ring it was shown to acceptRingChange", async () => {
    const onAccepted = vi.fn();
    const { container, ring } = await ringChangeWith(
      {},
      <RingChange onAccepted={onAccepted} />,
    );
    expect(container.textContent).toContain("Maya's MacBook");
    fireEvent.click(control(container, "ringChange.accept")!);
    await waitFor(() => expect(onAccepted).toHaveBeenCalled());
    expect(ring.acceptRingChange).toHaveBeenCalledWith(SERVED);
  });

  it("shows progress, takes one press at a time, and says when accepting did not work", async () => {
    let answer: (s: RingStatus) => void = () => undefined;
    const accept = vi.fn(() => new Promise<RingStatus>((r) => (answer = r)));
    const onAccepted = vi.fn();
    const { container, ring } = await ringChangeWith(
      { acceptRingChange: accept },
      <RingChange onAccepted={onAccepted} />,
    );
    fireEvent.click(control(container, "ringChange.accept")!);
    fireEvent.click(control(container, "ringChange.accept")!);
    expect(accept).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        control(container, "ringChange.accept")!.getAttribute("aria-disabled"),
      ).toBe("true"),
    );
    answer(changed);
    await waitFor(() =>
      expect(
        container.querySelector('[data-key="ringChange.failed"]'),
      ).not.toBeNull(),
    );
    expect(onAccepted).not.toHaveBeenCalled();
    // The ring was read again: Accept is available for the ring now served.
    expect(ring.status).toHaveBeenCalledTimes(2);
    expect(
      control(container, "ringChange.accept")!.getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("a refused accept says so", async () => {
    const ring = fakeRing({
      status: vi.fn(async () => changed),
      acceptRingChange: vi.fn(async () => {
        throw new PolarisError("network", "down");
      }),
    });
    const { container } = inProvider(ring, <RingChange />);
    await waitFor(() =>
      expect(control(container, "ringChange.accept")).not.toBeNull(),
    );
    fireEvent.click(control(container, "ringChange.accept")!);
    await waitFor(() =>
      expect(
        container.querySelector('[data-key="ringChange.failed"]'),
      ).not.toBeNull(),
    );
  });

  it("Use recovery code with no host handler opens UnlockSync itself", async () => {
    const ring = fakeRing({ status: vi.fn(async () => changed) });
    const { container } = inProvider(ring, <RingChange />);
    await waitFor(() =>
      expect(control(container, "ringChange.useCode")).not.toBeNull(),
    );
    fireEvent.click(control(container, "ringChange.useCode")!);
    await waitFor(() => expect(field(container)).not.toBeNull());
    fireEvent.click(control(container, "common.cancel")!);
    await waitFor(() =>
      expect(control(container, "ringChange.useCode")).not.toBeNull(),
    );
  });

  it("the recovery code is the primary; without a served ring there is no Accept and a line says why", () => {
    const { container } = render(
      <Part input={{ ringChange: { by: "Maya's MacBook" } }} />,
    );
    expect(control(container, "ringChange.accept")).toBeNull();
    expect(control(container, "ringChange.useCode")!.dataset.variant).toBe(
      "primary",
    );
    expect(
      container.querySelector('[data-key="ringChange.warningNoServed"]'),
    ).not.toBeNull();
  });

  it("the failed row says so above the actions", () => {
    const { container } = render(
      <Part input={{ ringChange: { served: SERVED, failed: true } }} />,
    );
    const reason = container.querySelector('[data-key="ringChange.failed"]')!;
    expect(
      reason.compareDocumentPosition(container.querySelector(".actions")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("draws nothing when the ring has not changed", async () => {
    const { container } = inProvider(fakeRing(), <RingChange />);
    await wait(20);
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

  it("in the provider, with no host handler, Unlock sync opens UnlockSync and Cancel returns", async () => {
    const { container } = inProvider(
      fakeRing(),
      <CloudSyncStatus input={{ cloudSync: { state: "locked" } }} />,
    );
    fireEvent.click(control(container, "cloudSync.unlock")!);
    await waitFor(() => expect(field(container)).not.toBeNull());
    fireEvent.click(control(container, "common.cancel")!);
    await waitFor(() =>
      expect(control(container, "cloudSync.unlock")).not.toBeNull(),
    );
  });

  it("Review opens RingChange; with a host handler the strip leaves the press to the host", async () => {
    const { container } = inProvider(
      fakeRing({ status: vi.fn(async () => changed) }),
      <CloudSyncStatus input={{ cloudSync: { state: "ring-changed" } }} />,
    );
    fireEvent.click(control(container, "common.review")!);
    await waitFor(() =>
      expect(control(container, "ringChange.accept")).not.toBeNull(),
    );
    cleanup();
    const onAction = vi.fn();
    const own = inProvider(
      fakeRing(),
      <CloudSyncStatus
        input={{ cloudSync: { state: "locked" } }}
        onAction={onAction}
      />,
    );
    fireEvent.click(control(own.container, "cloudSync.unlock")!);
    expect(onAction).toHaveBeenCalled();
    expect(field(own.container)).toBeNull();
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
