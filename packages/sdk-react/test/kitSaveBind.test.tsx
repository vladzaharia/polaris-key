// @pkey-feature ui.kit sync.saves
//
// K.2T (SAVES.R): the SaveConflict screen and the CloudSyncStatus transfer states follow
// `adapter.cloudSync.saves` when the host passes no input: a running write is `transferring` with
// the counted fraction, a failed one `transfer-failed`, a conflict is settled with `resolve`.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type {
  SaveConflict as Conflict,
  SaveOutcome,
  SaveTransfer,
} from "@polaris-key/client-core/sync";

import { CloudSyncStatus } from "../src/kit/statusDrive.js";
import { SaveConflict } from "../src/kit/syncScreens.js";
import { PolarisContext } from "../src/react/context.js";
import type { BrowserSaves, SaveTransferEvent } from "../src/core/cloudSync.js";

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

const CONFLICT: Conflict = {
  id: "slot1",
  local: { metadata: { n: 2 }, size: 10 },
  remote: {
    id: "slot1",
    version: 3,
    metadata: { n: 1 },
    file: null,
    newerFormat: false,
  },
  serverVersion: 3,
  bothAvailable: true,
};

function fakeSaves() {
  const listeners = new Set<(e: SaveTransferEvent | null) => void>();
  let running: SaveTransfer[] = [];
  let conflicts: Conflict[] = [];
  const resolve = vi.fn(async (..._a: unknown[]): Promise<SaveTransfer> => {
    const done: Promise<SaveOutcome> = Promise.resolve({
      state: "done",
      id: "slot1",
      kept: "remote",
      version: 3,
    });
    return {
      id: "saves:slot1",
      state: "done",
      progress: { done: 0, total: 0 },
      pause() {},
      resume() {},
      cancel: async () => undefined,
      done,
    };
  });
  const saves = {
    transfers: () => running,
    conflicts: () => conflicts,
    dismissConflict: vi.fn((id: string) => {
      conflicts = conflicts.filter((c) => c.id !== id);
      listeners.forEach((l) => l(null));
    }),
    onTransfers: (l: (e: SaveTransferEvent | null) => void) => (
      listeners.add(l),
      () => listeners.delete(l)
    ),
    resolve,
  } as unknown as BrowserSaves;
  return {
    saves,
    resolve,
    emit: (e: SaveTransferEvent | null) => listeners.forEach((l) => l(e)),
    setRunning: (t: SaveTransfer[]) => (running = t),
    setConflicts: (c: Conflict[]) => (conflicts = c),
  };
}

const inProvider = (saves: BrowserSaves, ui: React.ReactNode) =>
  render(
    <PolarisContext.Provider
      value={{ adapter: { cloudSync: { saves } } as never }}
    >
      {ui}
    </PolarisContext.Provider>,
  );

const write = (done: number, total: number): SaveTransfer =>
  ({
    id: "saves:slot1",
    state: "running",
    progress: { done, total },
  }) as unknown as SaveTransfer;

describe("CloudSyncStatus follows the saves", () => {
  it("is transferring with the counted fraction while a write runs, never Synced", () => {
    const f = fakeSaves();
    f.setRunning([write(30_000_000, 60_000_000)]);
    const { container } = inProvider(f.saves, <CloudSyncStatus />);
    expect(container.textContent).toMatch(/30 MB/);
    expect(container.textContent).toMatch(/60 MB/);
    expect(container.textContent).not.toMatch(/Synced/i);
    const bar = container.querySelector("[role=progressbar]");
    expect(bar?.getAttribute("aria-valuenow")).toBe("50");
  });

  it("is transfer-failed after a failed write, until the next one starts", async () => {
    const f = fakeSaves();
    const { container } = inProvider(f.saves, <CloudSyncStatus />);
    act(() =>
      f.emit({ type: "transferFailed", id: "saves:slot1", code: "rejected" }),
    );
    await waitFor(() =>
      expect(
        container.querySelector('button[data-key="common.tryAgain"]'),
      ).not.toBeNull(),
    );
  });

  it("leaves the host's input alone while nothing moves", () => {
    const f = fakeSaves();
    const { container } = inProvider(
      f.saves,
      <CloudSyncStatus input={{ cloudSync: { state: "offline" } }} />,
    );
    expect(container.textContent).toMatch(/offline/i);
  });
});

describe("SaveConflict follows the saves", () => {
  it("draws the pending conflict and settles it with resolve, then Done dismisses it", async () => {
    const f = fakeSaves();
    f.setConflicts([CONFLICT]);
    const bytes = vi.fn(() => Uint8Array.of(1, 2, 3));
    const { container } = inProvider(f.saves, <SaveConflict bytes={bytes} />);
    const keepThis = container.querySelector<HTMLButtonElement>(
      'button[data-key="saveConflict.keepThis"]',
    )!;
    expect(keepThis).not.toBeNull();
    fireEvent.click(keepThis);
    await waitFor(() =>
      expect(
        container.querySelector('button[data-key="common.done"]'),
      ).not.toBeNull(),
    );
    expect(f.resolve).toHaveBeenCalledWith(
      CONFLICT,
      "local",
      Uint8Array.of(1, 2, 3),
    );
    fireEvent.click(container.querySelector('button[data-key="common.done"]')!);
    expect(f.saves.dismissConflict).toHaveBeenCalledWith("slot1");
  });

  it("fails with Try again when the local copy is missing", async () => {
    const f = fakeSaves();
    f.setConflicts([CONFLICT]);
    const { container } = inProvider(f.saves, <SaveConflict />);
    fireEvent.click(
      container.querySelector('button[data-key="saveConflict.keepThis"]')!,
    );
    await waitFor(() =>
      expect(
        container.querySelector('button[data-key="common.tryAgain"]'),
      ).not.toBeNull(),
    );
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it("keeps the other copy without any bytes from the host", async () => {
    const f = fakeSaves();
    f.setConflicts([CONFLICT]);
    const { container } = inProvider(f.saves, <SaveConflict />);
    fireEvent.click(
      container.querySelector('button[data-key="saveConflict.keepOther"]')!,
    );
    await waitFor(() => expect(f.resolve).toHaveBeenCalledTimes(1));
    expect(f.resolve.mock.calls[0]![1]).toBe("remote");
  });

  it("is the host's plain part when it passes its own input", () => {
    const f = fakeSaves();
    f.setConflicts([CONFLICT]);
    const { container } = inProvider(
      f.saves,
      <SaveConflict
        input={{
          saveConflict: {
            step: "choose",
            local: {},
            remote: {},
            bothAvailable: false,
          },
        }}
      />,
    );
    fireEvent.click(
      container.querySelector('button[data-key="saveConflict.keepThis"]')!,
    );
    expect(f.resolve).not.toHaveBeenCalled();
  });
});
