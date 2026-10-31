// @pkey-feature ui.kit sync.saves
//
// U-22.K2: the save screens in the React kit. SaveConflict is the plain part (the host moves its
// step on): two cards, three choices with none filled, Keep both unavailable and described by its
// reason while every slot is in use, a deleted copy with its own button, no control while a choice
// is applied, Done after it is kept. CloudSyncStatus's transfer states never say Synced and draw a
// bar that is determinate only with counted bytes. The matrix rows are kitMatrix's `saveConflict`.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { CloudSyncStatus } from "../src/kit/statusDrive.js";
import { SaveConflict } from "../src/kit/syncScreens.js";
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
afterEach(cleanup);

const THIS = { when: "today, 14:02" };
const OTHER = { when: "yesterday, 21:40", device: "Maya's Steam Deck" };
const button = (c: HTMLElement, key: string) =>
  c.querySelector<HTMLButtonElement>(`button[data-key="${key}"]`);

describe("SaveConflict", () => {
  it("draws both copies and three choices, none of them filled", () => {
    const { container } = render(
      <SaveConflict
        input={{
          saveConflict: {
            step: "choose",
            local: THIS,
            remote: OTHER,
            bothAvailable: true,
          },
        }}
      />,
    );
    const cards = [...container.querySelectorAll("[data-part=save-card]")];
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain("Version on this device");
    expect(cards[0]!.textContent).toContain("today, 14:02");
    expect(cards[1]!.textContent).toContain("Maya's Steam Deck");
    for (const key of [
      "saveConflict.keepThis",
      "saveConflict.keepOther",
      "saveConflict.keepBoth",
    ])
      expect(button(container, key)?.getAttribute("aria-disabled")).toBeNull();
    expect(container.querySelector('[data-variant="primary"]')).toBeNull();
  });

  it("reports the choice, and only when the control is available", () => {
    const kept: string[] = [];
    const { container, rerender } = render(
      <SaveConflict
        input={{
          saveConflict: {
            step: "choose",
            local: THIS,
            remote: OTHER,
            bothAvailable: false,
          },
        }}
        onKeep={(k) => kept.push(k)}
      />,
    );
    fireEvent.click(button(container, "saveConflict.keepThis")!);
    fireEvent.click(button(container, "saveConflict.keepOther")!);
    // Keep both is unavailable while every slot is in use: the press does nothing.
    fireEvent.click(button(container, "saveConflict.keepBoth")!);
    expect(kept).toEqual(["local", "remote"]);
    rerender(
      <SaveConflict
        input={{
          saveConflict: {
            step: "choose",
            local: THIS,
            remote: OTHER,
            bothAvailable: true,
          },
        }}
        onKeep={(k) => kept.push(k)}
      />,
    );
    fireEvent.click(button(container, "saveConflict.keepBoth")!);
    expect(kept).toEqual(["local", "remote", "both"]);
  });

  it("draws the choices, the reason and Cancel as one undocked block in reading order", () => {
    const { container } = render(
      <SaveConflict
        input={{
          saveConflict: { step: "choose", local: THIS, remote: OTHER },
        }}
      />,
    );
    const blocks = container.querySelectorAll('[data-part="actions"]');
    expect(blocks).toHaveLength(1);
    const keys = [...blocks[0]!.children].map((n) =>
      n.getAttribute("data-key"),
    );
    expect(keys).toEqual([
      "saveConflict.keepThis",
      "saveConflict.keepOther",
      "saveConflict.keepBoth",
      "saveConflict.bothFull",
      "common.cancel",
    ]);
    expect(blocks[0]!.getAttribute("data-dock")).toBe("none");
  });

  it("keeps Keep both on screen, unavailable, described by its reason", () => {
    const { container } = render(
      <SaveConflict
        input={{
          saveConflict: {
            step: "choose",
            local: THIS,
            remote: OTHER,
            bothAvailable: false,
          },
        }}
      />,
    );
    const both = button(container, "saveConflict.keepBoth")!;
    expect(both.getAttribute("aria-disabled")).toBe("true");
    const reason = container.querySelector(
      `#${both.getAttribute("aria-describedby")}`,
    );
    expect(reason?.getAttribute("data-key")).toBe("saveConflict.bothFull");
    expect(reason?.textContent).toMatch(/slots are in use/i);
  });

  it("gives a deleted copy its own button and offers no Keep both", () => {
    const kept: string[] = [];
    const { container } = render(
      <SaveConflict
        input={{
          saveConflict: {
            step: "choose",
            local: THIS,
            remote: null,
            bothAvailable: true,
          },
        }}
        onKeep={(k) => kept.push(k)}
      />,
    );
    expect(button(container, "saveConflict.keepOther")).toBeNull();
    expect(button(container, "saveConflict.keepBoth")).toBeNull();
    expect(container.textContent).toContain("Deleted on another device");
    expect(container.querySelector("h1")?.textContent).toBe(
      "This save was deleted elsewhere",
    );
    expect(container.textContent).not.toContain("Two versions");
    expect(
      button(container, "saveConflict.acceptDelete")?.getAttribute(
        "data-variant",
      ),
    ).toBe("danger");
    fireEvent.click(button(container, "saveConflict.acceptDelete")!);
    expect(kept).toEqual(["remote"]);
  });

  it("offers no control while a choice is applied", () => {
    const { container } = render(
      <SaveConflict
        input={{ saveConflict: { step: "keeping", keep: "both" } }}
      />,
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Keeping your choice",
    );
  });

  it("says what was kept, then Done", () => {
    const done = vi.fn();
    const { container } = render(
      <SaveConflict
        input={{ saveConflict: { step: "kept", keep: "both" } }}
        onDone={done}
      />,
    );
    expect(container.textContent).toContain("Kept both");
    fireEvent.click(button(container, "common.done")!);
    expect(done).toHaveBeenCalledOnce();
  });

  it("repeats the choice on Try again, and leaves the conflict on Cancel", () => {
    const retry = vi.fn();
    const cancel = vi.fn();
    const { container } = render(
      <SaveConflict
        input={{ saveConflict: { step: "failed", keep: "local" } }}
        onRetry={retry}
        onCancel={cancel}
      />,
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Both saves are unchanged",
    );
    fireEvent.click(button(container, "common.tryAgain")!);
    fireEvent.click(button(container, "common.cancel")!);
    expect(retry).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("draws nothing without a conflict, and is a public, lazily loaded export", () => {
    const { container } = render(<SaveConflict input={{}} />);
    expect(container.querySelector(".pk-root")).toBeNull();
    expect(PublicKit.SaveConflict).toBeTypeOf("function");
  });
});

describe("CloudSyncStatus transfers", () => {
  const status = (cloudSync: object) =>
    render(<CloudSyncStatus input={{ cloudSync } as never} />).container;
  it("draws a counted bar and never says Synced", () => {
    const c = status({
      state: "transferring",
      lastSynced: "2 min ago",
      transfer: { size: "38 MB", total: "61 MB", fraction: 0.62 },
    });
    const bar = c.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("62");
    expect(c.textContent).toContain("38 MB of 61 MB");
    expect(c.textContent).not.toMatch(/synced/i);
  });
  it("draws an indeterminate bar when the bytes are not counted", () => {
    const c = status({ state: "transferring" });
    const bar = c.querySelector('[role="progressbar"]')!;
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.hasAttribute("data-indeterminate")).toBe(true);
  });
  it("names what a waiting transfer waits for", () => {
    expect(
      status({ state: "waiting", reason: "battery" }).textContent,
    ).toContain("Waiting for power");
  });
  it("draws the label before its figures and Try again as secondary", () => {
    const c = status({
      state: "transferring",
      transfer: { size: "38 MB", total: "61 MB", fraction: 0.62 },
    });
    const t = c.textContent ?? "";
    expect(t.indexOf("Syncing saves")).toBeLessThan(
      t.indexOf("38 MB of 61 MB"),
    );
    const failed = status({ state: "transfer-failed" });
    expect(
      button(failed, "common.tryAgain")?.getAttribute("data-variant"),
    ).toBe("secondary");
  });
  it("offers Try again on a failed transfer", () => {
    const seen: string[] = [];
    const { container } = render(
      <CloudSyncStatus
        input={{ cloudSync: { state: "transfer-failed" } } as never}
        onAction={(a) => seen.push(a.key)}
      />,
    );
    fireEvent.click(button(container, "common.tryAgain")!);
    expect(seen).toEqual(["common.tryAgain"]);
  });
});
