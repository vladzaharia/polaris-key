// @pkey-feature ui.kit ui.update
//
// UK-06.3: the kit's UpdateProgress draws the bytes a desktop host reports. A counted download is
// a determinate bar with both sizes; an unknown total is the indeterminate bar, with no value and
// no percentage (DL7).

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { UpdateProgress } from "@polaris-key/react/kit";
import { installProgressInput } from "../src/kit/adapt.js";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const bar = (c: HTMLElement) => c.querySelector('[role="progressbar"]');
const draw = (done: number, total: number | null) =>
  render(
    <UpdateProgress
      input={{
        update: {
          action: "binary",
          version: "2.0.0",
          progress: installProgressInput(done, total, "en"),
        },
      }}
    />,
  );

describe("UpdateProgress with real install bytes", () => {
  it("counted bytes: determinate, with both sizes", () => {
    expect(installProgressInput(25_000_000, 100_000_000, "en")).toEqual({
      phase: "download",
      fraction: 0.25,
      size: "25 MB",
      total: "100 MB",
    });
    const { container } = draw(25_000_000, 100_000_000);
    const b = bar(container)!;
    expect(b.getAttribute("aria-valuenow")).toBe("25");
    expect(b.hasAttribute("data-indeterminate")).toBe(false);
  });

  it("unknown total: indeterminate, no value, no invented percentage", () => {
    const p = installProgressInput(25_000_000, null, "en");
    expect(p).toEqual({ phase: "download", size: "25 MB" });
    expect(p).not.toHaveProperty("fraction");
    const { container } = draw(25_000_000, null);
    const b = bar(container)!;
    expect(b.hasAttribute("data-indeterminate")).toBe(true);
    expect(b.hasAttribute("aria-valuenow")).toBe(false);
    expect(container.textContent).not.toMatch(/\d+\s?%/);
  });

  it("a total smaller than the bytes done is not a count", () => {
    expect(installProgressInput(30, 20, "en")).not.toHaveProperty("fraction");
  });
});
