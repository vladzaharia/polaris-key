// @pkey-feature ui.signin ui.activate ui.settings ui.kit
//
// Bug package H2 (v0.9.15) in React, as in the elements: the no-browser hand-off has a heading,
// CloudSyncStatus offers Review only when the host handles it, a refused well-formed key is a
// neutral callout, the sign-in code is spelled out for a screen reader, the Welcome byline sits
// under the title, and an account row naming a missing fact is left out.

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { UiInput } from "@polaris-key/ui-core";

import {
  AccountAndLicense,
  Activate,
  CloudSyncStatus,
  SignInHandoff,
  Welcome,
} from "@polaris-key/react/kit";

const BASE: UiInput = {
  elapsedMs: 60_000,
  services: ["license", "sync", "identity"],
  presentation: {
    name: "Tidewater Studio",
    developerName: "Harbor Audio",
    icon: false,
  },
  bundle: { slug: "tidewater", name: "Tidewater Studio" },
  platform: { os: "web", formFactor: "computer" },
  registration: "requires-license",
  capabilities: { signIn: true, keyEntry: true, deviceCode: true },
};
const input = (patch: Partial<UiInput>): UiInput => ({ ...BASE, ...patch });

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the no-browser hand-off", () => {
  it("draws its first line as the heading", () => {
    const { container } = render(
      <SignInHandoff
        input={input({
          signIn: {
            presentation: "inline",
            replace: "inline",
            channel: "browser",
            outcome: "pending",
            browserOpened: false,
          },
        })}
      />,
    );
    expect(
      container.querySelector('h1[data-key="signin.handoff.noBrowser"]'),
    ).not.toBeNull();
  });
});

describe("CloudSyncStatus", () => {
  it("draws Review only when the host handles the conflict", () => {
    const plain = render(
      <CloudSyncStatus input={input({ cloudSync: { state: "conflict" } })} />,
    );
    expect(
      plain.container.querySelector('[data-key="common.review"]'),
    ).toBeNull();
    cleanup();
    const handled = render(
      <CloudSyncStatus
        input={input({ cloudSync: { state: "conflict", canReview: true } })}
      />,
    );
    expect(
      handled.container.querySelector('button[data-key="common.review"]'),
    ).not.toBeNull();
  });

  it("says a signed-out error once, neutrally, with Sign in to sync", () => {
    const { container } = render(
      <CloudSyncStatus
        input={input({ cloudSync: { state: "error", signedIn: false } })}
      />,
    );
    expect(
      container.querySelector('[data-key="cloudSync.signedOut"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-key="cloudSync.error"]')).toBeNull();
    expect(
      container.querySelector('button[data-key="cloudSync.signIn"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-part="status"]')
        ?.getAttribute("data-status"),
    ).toBe("neutral");
  });
});

describe("Activate's refusal tone", () => {
  it("is a neutral callout for a refused, well-formed key", () => {
    const { container } = render(
      <Activate
        input={input({
          keyField: {
            text: "pkey_tidewater_AbCdEfGhIjKlMnOpQrStUv",
            submitted: true,
          },
          activation: { result: "license-disabled" },
        })}
      />,
    );
    expect(container.querySelector(".callout")?.getAttribute("data-tone")).toBe(
      "neutral",
    );
    expect(container.querySelector("input")?.getAttribute("aria-invalid")).toBe(
      "false",
    );
  });
  it("is danger, with the stroke, for a key that is not one", () => {
    const { container } = render(
      <Activate input={input({ keyField: { text: "tidewater-2024-pro" } })} />,
    );
    expect(
      container.querySelector(".callout, .message")?.getAttribute("data-tone"),
    ).toBe("danger");
    expect(container.querySelector("input")?.getAttribute("aria-invalid")).toBe(
      "true",
    );
  });
});

describe("the sign-in code", () => {
  it("is spelled out for a screen reader and drawn as served", () => {
    const { container } = render(
      <SignInHandoff
        input={input({
          signIn: {
            presentation: "inline",
            replace: "inline",
            channel: "device-code",
            browserOpened: false,
          },
          deviceCode: {
            phase: "waiting",
            userCode: "WDJB-MJHT",
            secondsLeft: 598,
            verificationUri: "https://polaris.locker/device",
          },
        } as Partial<UiInput>)}
      />,
    );
    const code = container.querySelector('[data-key="a11y.code"]');
    expect(code?.getAttribute("aria-label")).toContain("W D J B - M J H T");
    expect(code?.textContent?.trim()).toBe("WDJB-MJHT");
  });
});

describe("the Welcome byline", () => {
  it("sits under the title, not in the header", () => {
    const { container } = render(<Welcome input={input({})} />);
    expect(
      container.querySelector('[data-key="common.byDeveloper"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-part="developer"]')?.closest(".identity"),
    ).toBeNull();
  });
});

describe("the account pane", () => {
  it("leaves out a row that names a fact the input lacks", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(
      <AccountAndLicense
        input={input({ account: { signedIn: true } } as Partial<UiInput>)}
      />,
    );
    const list = container.querySelector('[data-part="account-list"]');
    expect(list?.textContent ?? "").not.toMatch(/\{[A-Za-z]\w*\}/);
  });
});
