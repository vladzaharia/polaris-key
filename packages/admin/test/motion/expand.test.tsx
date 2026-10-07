import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Expand, SuccessCheck } from "../../src/ui/motion/index.js";

/**
 * The expand pattern and the plain success check (notes/S-23 §6.1; MO-06), as far as jsdom can
 * see them. jsdom has no Web Animations API, so by default nothing animates and every step is at
 * once; a stubbed `getAnimations` stands in for a running transition where the waiting is under
 * test. The real transitions run in e2e/deviceMotion.e2e.test.ts.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.motion;
  delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
});

/** A running animation whose `finished` the test settles. */
function deferredAnimation(): { anim: Animation; finish: () => void } {
  let finish!: () => void;
  const finished = new Promise<Animation>((r) => {
    finish = () => r(anim);
  });
  const anim = { finished } as unknown as Animation;
  return { anim, finish };
}

function Probe({
  open,
  onOpen,
  onOpened,
}: {
  open: boolean;
  onOpen?: () => void;
  onOpened?: (el: HTMLElement) => void;
}): React.ReactElement {
  return (
    <Expand id="panel" open={open} onOpen={onOpen} onOpened={onOpened}>
      <h3 tabIndex={-1}>Remove Studio PC?</h3>
      <button type="button">Keep it</button>
    </Expand>
  );
}

const region = () => document.getElementById("panel")!;

describe("Expand", () => {
  it("holds nothing while closed: no text, no buttons, only the empty region", () => {
    render(<Probe open={false} />);
    expect(region().className).toMatch(/\bpk-expand\b/);
    expect(region().hasAttribute("data-open")).toBe(false);
    expect(region().childElementCount).toBe(0);
    expect(screen.queryByText("Remove Studio PC?")).toBeNull();
  });

  it("opens: content in, then data-open; onOpen once it shows (focus lands), onOpened after", async () => {
    const seen: string[] = [];
    const onOpen = vi.fn(() => {
      seen.push(region().hasAttribute("data-open") ? "open" : "closed");
      screen.getByText("Remove Studio PC?").focus();
    });
    const onOpened = vi.fn();
    const { rerender } = render(
      <Probe open={false} onOpen={onOpen} onOpened={onOpened} />,
    );
    rerender(<Probe open onOpen={onOpen} onOpened={onOpened} />);
    expect(region().hasAttribute("data-open")).toBe(true);
    expect(seen).toEqual(["open"]);
    expect(document.activeElement).toBe(screen.getByText("Remove Studio PC?"));
    await act(async () => undefined);
    expect(onOpened).toHaveBeenCalledWith(region());
    // A re-render while open calls neither again.
    rerender(<Probe open onOpen={onOpen} onOpened={onOpened} />);
    await act(async () => undefined);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it("reads the closed style before it sets data-open, so the row has a start to move from", () => {
    const order: string[] = [];
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      if (el === document.getElementById("panel"))
        order.push(
          (el as HTMLElement).hasAttribute("data-open") ? "open" : "closed",
        );
      return real(el, pseudo);
    });
    const { rerender } = render(<Probe open={false} />);
    rerender(<Probe open />);
    expect(order[0]).toBe("closed");
    expect(region().hasAttribute("data-open")).toBe(true);
  });

  it("mounting open shows open at once and never replays (no onOpen on mount)", async () => {
    const onOpen = vi.fn();
    render(<Probe open onOpen={onOpen} />);
    expect(region().hasAttribute("data-open")).toBe(true);
    expect(screen.getByText("Remove Studio PC?")).toBeTruthy();
    await act(async () => undefined);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("closes at once when nothing animates (jsdom, reduced motion)", () => {
    const { rerender } = render(<Probe open />);
    rerender(<Probe open={false} />);
    expect(region().hasAttribute("data-open")).toBe(false);
    expect(screen.queryByText("Remove Studio PC?")).toBeNull();
  });

  it("keeps the content through the closing, then removes it once that has finished", async () => {
    const { anim, finish } = deferredAnimation();
    (Element.prototype as { getAnimations?: unknown }).getAnimations = () => [
      anim,
    ];
    const { rerender } = render(<Probe open />);
    rerender(<Probe open={false} />);
    expect(region().hasAttribute("data-open")).toBe(false);
    expect(screen.getByText("Remove Studio PC?")).toBeTruthy();
    await act(async () => finish());
    expect(screen.queryByText("Remove Studio PC?")).toBeNull();
  });

  it("never waits on an endless animation inside (a pending button's spinner)", async () => {
    // A spinner runs for ever: its `finished` never settles.
    const spinner = {
      finished: new Promise<Animation>(() => undefined),
      effect: { getTiming: () => ({ iterations: Infinity }) },
    } as unknown as Animation;
    (Element.prototype as { getAnimations?: unknown }).getAnimations = () => [
      spinner,
    ];
    const { rerender } = render(<Probe open />);
    rerender(<Probe open={false} />);
    await act(async () => undefined);
    expect(screen.queryByText("Remove Studio PC?")).toBeNull();
    // Beside the closing's own transition, only that transition is waited on.
    const closing = deferredAnimation();
    (Element.prototype as { getAnimations?: unknown }).getAnimations = () => [
      spinner,
      closing.anim,
    ];
    rerender(<Probe open />);
    rerender(<Probe open={false} />);
    await act(async () => undefined);
    expect(screen.getByText("Remove Studio PC?")).toBeTruthy();
    await act(async () => closing.finish());
    expect(screen.queryByText("Remove Studio PC?")).toBeNull();
  });

  it("a re-open during the closing cancels it: the content stays, and the old close never unmounts it", async () => {
    const first = deferredAnimation();
    (Element.prototype as { getAnimations?: unknown }).getAnimations = () => [
      first.anim,
    ];
    const onOpen = vi.fn();
    const { rerender } = render(<Probe open onOpen={onOpen} />);
    rerender(<Probe open={false} onOpen={onOpen} />);
    rerender(<Probe open onOpen={onOpen} />);
    expect(region().hasAttribute("data-open")).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
    await act(async () => first.finish());
    expect(screen.getByText("Remove Studio PC?")).toBeTruthy();
    expect(region().hasAttribute("data-open")).toBe(true);
    // And a later close still closes (nothing was left pending).
    (Element.prototype as { getAnimations?: unknown }).getAnimations = () => [];
    rerender(<Probe open={false} onOpen={onOpen} />);
    await act(async () => undefined);
    expect(screen.queryByText("Remove Studio PC?")).toBeNull();
  });

  it('reaches the same end states under reduced motion (html[data-motion="reduce"])', async () => {
    document.documentElement.dataset.motion = "reduce";
    const onOpen = vi.fn();
    const onOpened = vi.fn();
    const { rerender } = render(
      <Probe open={false} onOpen={onOpen} onOpened={onOpened} />,
    );
    rerender(<Probe open onOpen={onOpen} onOpened={onOpened} />);
    await act(async () => undefined);
    expect(region().hasAttribute("data-open")).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpened).toHaveBeenCalledTimes(1);
    rerender(<Probe open={false} onOpen={onOpen} onOpened={onOpened} />);
    expect(screen.queryByText("Remove Studio PC?")).toBeNull();
  });
});

describe("SuccessCheck", () => {
  it("is the check alone: decorative, drawn by .pk-check, no sparks", () => {
    const { container } = render(<SuccessCheck size={16} />);
    const mark = container.firstElementChild as HTMLElement;
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.className).toMatch(/\bpk-celebration\b/);
    expect(mark.querySelector("svg.pk-check path")).toBeTruthy();
    expect(mark.querySelector(".pk-burst")).toBeNull();
    expect(mark.hasAttribute("data-celebrate")).toBe(false);
  });

  it("a re-render keeps the same element, so its draw never replays", () => {
    const { container, rerender } = render(<SuccessCheck size={16} />);
    const path = container.querySelector("path");
    rerender(<SuccessCheck size={16} className="text-success" />);
    expect(container.querySelector("path")).toBe(path);
  });
});
