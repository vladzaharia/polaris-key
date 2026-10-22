// @pkey-feature ui.kit
//
// StatusScreen, expired: Renew is drawn only when the host can renew (a renewUrl, an onRenew, or
// input.renew); otherwise Use another license stands alone as the primary.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { PolarisKeyGate, StatusScreen } from "@polaris-key/react/kit";
import type { UiInput } from "@polaris-key/ui-core";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const expired: UiInput = {
  gate: { status: "expired" },
  bundle: { slug: "tidewater", name: "Tidewater Studio" },
};
const controls = (c: HTMLElement) =>
  [
    ...c.querySelectorAll<HTMLElement>(
      "[data-part=primary],[data-part=secondary]",
    ),
  ].map((e) => [e.dataset.key, e.dataset.part]);

describe("StatusScreen expired", () => {
  it("offers Use another license alone without a renewal", () => {
    const { container } = render(<StatusScreen input={expired} />);
    expect(controls(container)).toEqual([
      ["status.useAnotherLicense", "primary"],
    ]);
  });

  it("draws Renew with the new-window glyph for a renewUrl and reports the url", () => {
    const onAction = vi.fn();
    const { container } = render(
      <StatusScreen
        input={expired}
        renewUrl="https://example.com/renew"
        onAction={onAction}
      />,
    );
    expect(controls(container)).toEqual([
      ["status.renew", "primary"],
      ["status.useAnotherLicense", "secondary"],
    ]);
    const renew = container.querySelector<HTMLElement>(
      '[data-key="status.renew"]',
    )!;
    expect(renew.querySelector("svg")).not.toBeNull();
    fireEvent.click(renew);
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "status.renew",
        url: "https://example.com/renew",
      }),
    );
  });

  it("draws Renew without the glyph for an onRenew handler and runs it", () => {
    const onRenew = vi.fn();
    const { container } = render(
      <StatusScreen input={expired} onRenew={onRenew} />,
    );
    const renew = container.querySelector<HTMLElement>(
      '[data-key="status.renew"]',
    )!;
    expect(renew.querySelector("svg")).toBeNull();
    fireEvent.click(renew);
    expect(onRenew).toHaveBeenCalledTimes(1);
  });

  it("draws no Renew for a renewUrl that fails the link rule", () => {
    const { container } = render(
      <StatusScreen input={expired} renewUrl="javascript:alert(1)" />,
    );
    expect(container.querySelector('[data-key="status.renew"]')).toBeNull();
  });

  it("the gate takes the same props", () => {
    const bare = render(<PolarisKeyGate input={expired} />).container;
    expect(bare.querySelector('[data-key="status.renew"]')).toBeNull();
    cleanup();
    const withUrl = render(
      <PolarisKeyGate input={expired} renewUrl="https://example.com/renew" />,
    ).container;
    expect(withUrl.querySelector('[data-key="status.renew"]')).not.toBeNull();
  });
});
