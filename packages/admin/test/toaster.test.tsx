import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import * as React from "react";
import { ApiError } from "../src/api.js";
import { Toaster, useToast } from "../src/components/ui/index.js";
import { AppToaster, TOAST_DURATIONS, toast } from "../src/ui/toast.js";

/**
 * The toaster contract (components.md §5.1, UI-11). Changed with chunk 3's move to sonner:
 * success and info last 4 s (were 5 s), warnings 8 s, errors stay until dismissed (they used to
 * vanish after 5 s), and the timer pauses while the tab is hidden (sonner's rule; it used to be
 * window blur). sonner also keeps a removed toast 200 ms for its exit transition.
 */
const EXIT = 200;

function Trigger({ duration }: { duration?: number }): React.ReactElement {
  const t = useToast();
  return (
    <button type="button" onClick={() => t.toast({ title: "Saved", duration })}>
      go
    </button>
  );
}

function renderLegacy(duration?: number): void {
  render(
    <Toaster>
      <Trigger duration={duration} />
    </Toaster>,
  );
  act(() => screen.getByRole("button", { name: "go" }).click());
  act(() => vi.advanceTimersByTime(1)); // sonner adds a toast on the next tick
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(async () => {
  cleanup();
  await Promise.resolve(); // let the unmounted toaster dismiss what was left
  setHidden(false);
  vi.useRealTimers();
});

describe("toaster durations", () => {
  it("declares 4 s / 4 s / 8 s / persistent", () => {
    expect(TOAST_DURATIONS).toEqual({
      success: 4000,
      info: 4000,
      warning: 8000,
      error: Infinity,
    });
  });

  it("dismisses a toast after its duration (legacy useToast)", () => {
    vi.useFakeTimers();
    renderLegacy(1_000);
    expect(screen.getByText("Saved")).toBeTruthy();
    act(() => vi.advanceTimersByTime(999));
    expect(screen.queryByText("Saved")).not.toBeNull();
    act(() => vi.advanceTimersByTime(1 + EXIT));
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("dismisses a success after 4 s", () => {
    vi.useFakeTimers();
    render(<AppToaster />);
    act(() => void toast.success("License enabled"));
    act(() => vi.advanceTimersByTime(1));
    act(() => vi.advanceTimersByTime(3_900));
    expect(screen.queryByText("License enabled")).not.toBeNull();
    act(() => vi.advanceTimersByTime(100 + EXIT));
    expect(screen.queryByText("License enabled")).toBeNull();
  });

  it("keeps an error until it is dismissed (UI-11), worded by errorCopy", () => {
    vi.useFakeTimers();
    render(<AppToaster />);
    act(() => void toast.error(new ApiError(429, undefined, "rate_limited")));
    act(() => vi.advanceTimersByTime(1));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Too many requests")).toBeTruthy();
    expect(screen.getByText("Wait a moment and try again.")).toBeTruthy();
    expect(screen.queryByText(/api 429/)).toBeNull();
  });

  it("pauses while the tab is hidden and resumes with the time that was left", () => {
    vi.useFakeTimers();
    renderLegacy(1_000);
    act(() => vi.advanceTimersByTime(400));
    act(() => setHidden(true));
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.queryByText("Saved")).not.toBeNull();
    act(() => setHidden(false));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByText("Saved")).not.toBeNull();
    act(() => vi.advanceTimersByTime(200 + EXIT));
    expect(screen.queryByText("Saved")).toBeNull();
  });

  // Radix's Toast never cleared its close timer on unmount; a toast still open when its tree
  // unmounted fired after jsdom was torn down (CI on products.test.tsx). Still must not happen.
  it("leaves no pending timer once the tree unmounts with a toast open", async () => {
    vi.useFakeTimers();
    renderLegacy();
    expect(screen.getByText("Saved")).toBeTruthy();
    cleanup();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("toaster behaviour", () => {
  it("dedupes identical toasts", () => {
    vi.useFakeTimers();
    render(<AppToaster />);
    act(() => {
      toast.success("Copied");
      toast.success("Copied");
    });
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getAllByText("Copied")).toHaveLength(1);
  });

  it("offers an Undo action", () => {
    vi.useFakeTimers();
    const undo = vi.fn();
    render(<AppToaster />);
    act(
      () =>
        void toast.success("License disabled", {
          action: { label: "Undo", onClick: undo },
        }),
    );
    act(() => vi.advanceTimersByTime(1));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledOnce();
  });

  it("has a close button and a labelled region", () => {
    vi.useFakeTimers();
    render(<AppToaster />);
    act(() => void toast.warning("Readiness is stale"));
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("region", { name: /Notifications/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close toast" })).toBeTruthy();
  });

  it("does not replay a previous tree's toasts into a new toaster", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<AppToaster />);
    act(() => void toast.error("Leftover"));
    act(() => vi.advanceTimersByTime(1));
    unmount();
    await Promise.resolve();
    render(<AppToaster />);
    act(() => vi.advanceTimersByTime(10));
    expect(screen.queryByText("Leftover")).toBeNull();
  });
});
