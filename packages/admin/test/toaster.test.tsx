import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import * as React from "react";
import { Toaster, useToast } from "../src/components/ui/index.js";

function Trigger({ duration }: { duration?: number }): React.ReactElement {
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={() => toast.toast({ title: "Saved", duration })}
    >
      go
    </button>
  );
}

function renderToaster(duration?: number): void {
  render(
    <Toaster>
      <Trigger duration={duration} />
    </Toaster>,
  );
  act(() => screen.getByRole("button", { name: "go" }).click());
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Toaster auto-dismiss", () => {
  it("dismisses a toast after its duration", () => {
    vi.useFakeTimers();
    renderToaster(1_000);
    expect(screen.getByText("Saved")).toBeTruthy();

    act(() => vi.advanceTimersByTime(999));
    expect(screen.queryByText("Saved")).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("pauses while the window is blurred and resumes with the time that was left", () => {
    vi.useFakeTimers();
    renderToaster(1_000);

    act(() => vi.advanceTimersByTime(400));
    act(() => {
      fireEvent.blur(window);
    });
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.queryByText("Saved")).not.toBeNull();

    act(() => {
      fireEvent.focus(window);
    });
    act(() => vi.advanceTimersByTime(599));
    expect(screen.queryByText("Saved")).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Saved")).toBeNull();
  });

  // Radix's Toast never clears its close timer on unmount, so a toast that is still open when
  // its tree unmounts used to leave a 5 s timer behind. In the test runner that timer fired
  // after jsdom was torn down ("document is not defined", CI on products.test.tsx).
  it("leaves no pending timer once the tree unmounts with a toast open", () => {
    vi.useFakeTimers();
    renderToaster();
    expect(screen.getByText("Saved")).toBeTruthy();

    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });
});
