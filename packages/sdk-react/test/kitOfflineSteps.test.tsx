// @pkey-feature ui.kit ui.activate ui.paywall
//
// UIM-05 (UK-64): OfflineActivation draws two numbered steps with the request QR under its own
// label, reports the pasted response with Activate, and the Paywall's not-available state hands
// off to a valid https `offers.url` only.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import type { UiInput } from "@polaris-key/ui-core";
import { OfflineActivation, Paywall } from "@polaris-key/react/kit";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

describe("OfflineActivation two steps", () => {
  it("numbers the steps, labels the request QR and reports the response", () => {
    const onAction = vi.fn();
    const { container } = render(
      <OfflineActivation
        input={{
          capabilities: { offlineActivation: true },
          offline: { requestCode: "REQ-1234-ABCD", response: "signed" },
        }}
        onAction={onAction}
        onInput={() => {}}
      />,
    );
    expect(container.querySelectorAll("ol.steps > li")).toHaveLength(2);
    const qr = container.querySelector('[data-key="a11y.qrRequest"] svg');
    expect(qr?.getAttribute("aria-label")).toBe(
      "QR code with the request code",
    );
    expect(container.textContent).not.toContain("Product:");
    fireEvent.click(
      container.querySelector('[data-key="offlineActivation.submit"]')!,
    );
    expect(onAction.mock.calls.at(-1)?.[0]).toMatchObject({
      key: "offlineActivation.submit",
      response: "signed",
    });
  });

  it("keeps the form after a rejected file and ends done with a Done button", () => {
    const rejected = render(
      <OfflineActivation
        input={{
          capabilities: { offlineActivation: true },
          offline: { file: true, submitted: true, verified: false },
        }}
      />,
    );
    expect(rejected.container.querySelectorAll("ol.steps > li")).toHaveLength(
      2,
    );
    cleanup();
    const done = render(
      <OfflineActivation
        input={{
          capabilities: { offlineActivation: true },
          offline: { file: true, submitted: true, verified: true },
        }}
      />,
    );
    expect(done.container.querySelector("ol.steps")).toBeNull();
    expect(
      done.container.querySelector('[data-key="common.done"]'),
    ).not.toBeNull();
  });
});

describe("Paywall not-available hand-off", () => {
  const base: UiInput = {
    platform: { os: "web", formFactor: "computer" },
    entitlement: { name: "pro.export", entitled: false },
  };
  it("offers the portal for an https link and reports it", () => {
    const onAction = vi.fn();
    const { container } = render(
      <Paywall
        input={{
          ...base,
          offers: { available: false, url: "https://polaris.locker/activate" },
        }}
        onAction={onAction}
      />,
    );
    fireEvent.click(container.querySelector('[data-key="paywall.portal"]')!);
    expect(onAction.mock.calls.at(-1)?.[0]).toMatchObject({
      key: "paywall.portal",
      url: "https://polaris.locker/activate",
    });
  });

  it("offers nothing for a link that is not https", () => {
    const { container } = render(
      <Paywall
        input={{
          ...base,
          offers: { available: false, url: "http://tidewater.example/buy" },
        }}
      />,
    );
    expect(container.querySelector('[data-key="paywall.portal"]')).toBeNull();
  });
});
