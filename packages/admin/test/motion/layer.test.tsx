import * as React from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Celebration,
  CountUp,
  Presence,
  celebrateOnce,
  highlight,
  reducedMotion,
  setMeter,
  useReducedMotion,
} from "../../src/ui/motion/index.js";
import { expectNoAxeViolations } from "../coreTestUtils.js";

/**
 * The motion layer's React half and helpers (notes/S-23 §6). jsdom has no Web Animations API and
 * no View Transitions, so every function must no-op cleanly here; the motion itself is checked in
 * a real browser (e2e/kit.e2e.test.ts).
 */

const html = document.documentElement;

/** jsdom has no Element.getAnimations: install a stand-in returning `animations` for the test. */
function withAnimations(
  animations: () => Array<{ finished: Promise<unknown> }>,
): () => void {
  const proto = Element.prototype as unknown as { getAnimations?: unknown };
  proto.getAnimations = animations;
  return () => {
    delete proto.getAnimations;
  };
}

afterEach(() => {
  delete html.dataset.motion;
  localStorage.clear();
  vi.useRealTimers();
});

describe("reducedMotion / useReducedMotion", () => {
  it("follows html[data-motion] and re-renders when it changes", async () => {
    expect(reducedMotion()).toBe(false);
    function Probe() {
      return <span>{useReducedMotion() ? "reduced" : "full"}</span>;
    }
    render(<Probe />);
    expect(screen.getByText("full")).toBeTruthy();
    await act(async () => {
      html.dataset.motion = "reduce";
      await Promise.resolve();
    });
    expect(reducedMotion()).toBe(true);
    expect(await screen.findByText("reduced")).toBeTruthy();
  });

  it("follows the OS setting", () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) =>
      ({
        matches: true,
        media: q,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    try {
      expect(reducedMotion()).toBe(true);
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("<Presence>", () => {
  function Host({ open }: { open: boolean }) {
    return (
      <Presence open={open}>
        <div className="pk-transient">Saved</div>
      </Presence>
    );
  }

  it("marks the child open, and unmounts it at once without the Web Animations API", () => {
    const onExited = vi.fn();
    const { rerender } = render(
      <Presence open onExited={onExited}>
        <div className="pk-transient">Saved</div>
      </Presence>,
    );
    expect(screen.getByText("Saved").getAttribute("data-state")).toBe("open");
    rerender(
      <Presence open={false} onExited={onExited}>
        <div className="pk-transient">Saved</div>
      </Presence>,
    );
    expect(screen.queryByText("Saved")).toBeNull();
    expect(onExited).toHaveBeenCalledTimes(1);
  });

  it("keeps a closing child mounted until its exit animation finishes", async () => {
    let finish!: () => void;
    const finished = new Promise<void>((r) => (finish = r));
    const restore = withAnimations(() => [{ finished }]);
    try {
      const { rerender } = render(<Host open />);
      rerender(<Host open={false} />);
      const node = screen.getByText("Saved");
      expect(node.getAttribute("data-state")).toBe("closed");
      await act(async () => {
        finish();
        await finished;
      });
      expect(screen.queryByText("Saved")).toBeNull();
    } finally {
      restore();
    }
  });

  it("unmounts at once under reduced motion even with animations running", () => {
    html.dataset.motion = "reduce";
    const restore = withAnimations(() => [{ finished: new Promise(() => {}) }]);
    try {
      const { rerender } = render(<Host open />);
      rerender(<Host open={false} />);
      expect(screen.queryByText("Saved")).toBeNull();
    } finally {
      restore();
    }
  });

  it("reopens a closing child", () => {
    const { rerender } = render(<Host open={false} />);
    expect(screen.queryByText("Saved")).toBeNull();
    rerender(<Host open />);
    expect(screen.getByText("Saved").getAttribute("data-state")).toBe("open");
  });
});

describe("<CountUp>", () => {
  it("exposes exactly one accessible number", async () => {
    const { container } = render(
      <p>
        Devices: <CountUp value={1234} from={0} />
      </p>,
    );
    const hidden = container.querySelector('[aria-hidden="true"]')!;
    const twin = container.querySelector(".sr-only")!;
    expect(twin.textContent).toBe((1234).toLocaleString());
    expect(hidden.textContent).not.toBe("");
    // The visible digits are hidden from assistive technology; only the twin is read.
    const readable = Array.from(container.querySelectorAll("span"))
      .filter(
        (s) => !s.closest('[aria-hidden="true"]') && s.children.length === 0,
      )
      .map((s) => s.textContent);
    expect(readable).toEqual([(1234).toLocaleString()]);
    await expectNoAxeViolations(container);
  });

  it("counts on frame timestamps to the final value", async () => {
    const frames: FrameRequestCallback[] = [];
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb) => frames.push(cb));
    try {
      const { container } = render(
        <CountUp value={10} from={0} duration={100} />,
      );
      const visible = () =>
        container.querySelector('[aria-hidden="true"]')!.textContent;
      expect(visible()).toBe("0");
      act(() => frames.shift()!(1000)); // first frame: t = 0
      act(() => frames.shift()!(1050)); // half way, eased past half
      const mid = Number(visible());
      expect(mid).toBeGreaterThan(5);
      expect(mid).toBeLessThan(10);
      act(() => frames.shift()!(1100));
      expect(visible()).toBe("10");
      expect(frames).toHaveLength(0);
    } finally {
      raf.mockRestore();
    }
  });

  it("swaps instantly under reduced motion", () => {
    html.dataset.motion = "reduce";
    const raf = vi.spyOn(window, "requestAnimationFrame");
    try {
      const { container, rerender } = render(<CountUp value={2} />);
      rerender(<CountUp value={3} />);
      expect(container.querySelector('[aria-hidden="true"]')!.textContent).toBe(
        "3",
      );
      expect(raf).not.toHaveBeenCalled();
    } finally {
      raf.mockRestore();
    }
  });
});

describe("setMeter and highlight", () => {
  it("sets the fill through a custom property, clamped", () => {
    const el = document.createElement("div");
    setMeter(el, 0.5);
    expect(el.style.getPropertyValue("--pk-meter")).toBe("0.5");
    setMeter(el, 3);
    expect(el.style.getPropertyValue("--pk-meter")).toBe("1");
    setMeter(el, -1);
    expect(el.style.getPropertyValue("--pk-meter")).toBe("0");
    setMeter(el, Number.NaN);
    expect(el.style.getPropertyValue("--pk-meter")).toBe("0");
    expect(() => setMeter(null, 1)).not.toThrow();
  });

  it("tints a row for the highlight delay, then clears the tint", () => {
    vi.useFakeTimers();
    const row = document.createElement("tr");
    highlight(row);
    expect(row.classList.contains("pk-row-highlight")).toBe(true);
    vi.advanceTimersByTime(1599);
    expect(row.classList.contains("pk-row-highlight")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(row.classList.contains("pk-row-highlight")).toBe(false);
    expect(row.classList.contains("pk-row")).toBe(true);
  });

  it("keeps the tint under reduced motion (a delay, not motion)", () => {
    vi.useFakeTimers();
    html.dataset.motion = "reduce";
    const row = document.createElement("tr");
    const clear = highlight(row);
    expect(row.classList.contains("pk-row-highlight")).toBe(true);
    clear();
    expect(row.classList.contains("pk-row-highlight")).toBe(false);
  });
});

describe("<Celebration>", () => {
  it("bursts once per moment key, aria-hidden, then shows a static check", () => {
    const first = render(<Celebration momentKey="first-release:djdl" />);
    const root = first.container.firstElementChild!;
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.hasAttribute("data-celebrate")).toBe(true);
    expect(root.querySelector(".pk-check")).not.toBeNull();
    expect(localStorage.getItem("pk-moment:first-release:djdl")).toBe("1");
    first.unmount();

    const again = render(<Celebration momentKey="first-release:djdl" />);
    const root2 = again.container.firstElementChild!;
    expect(root2.hasAttribute("data-celebrate")).toBe(false);
    expect(root2.hasAttribute("data-static")).toBe(true);
    expect(root2.querySelector(".pk-burst")).toBeNull();
  });

  it("is a static check with no burst under reduced motion", () => {
    html.dataset.motion = "reduce";
    const { container } = render(<Celebration momentKey="first-activation" />);
    const root = container.firstElementChild!;
    expect(root.hasAttribute("data-static")).toBe(true);
    expect(root.querySelector(".pk-burst")).toBeNull();
    expect(root.querySelector(".pk-check")).not.toBeNull();
  });

  it("renders six sparks while the burst runs", () => {
    const restore = withAnimations(() => [{ finished: new Promise(() => {}) }]);
    try {
      const { container } = render(<Celebration momentKey="store-connected" />);
      expect(container.querySelectorAll(".pk-burst > i")).toHaveLength(6);
    } finally {
      restore();
    }
  });

  it("celebrates anyway when storage is unavailable", () => {
    const get = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    try {
      expect(celebrateOnce("x")).toBe(true);
      const { container } = render(<Celebration momentKey="x" />);
      expect(container.firstElementChild!.hasAttribute("data-celebrate")).toBe(
        true,
      );
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it("claims a moment once with celebrateOnce", () => {
    expect(celebrateOnce("licence-created:acme")).toBe(true);
    expect(celebrateOnce("licence-created:acme")).toBe(false);
  });
});
