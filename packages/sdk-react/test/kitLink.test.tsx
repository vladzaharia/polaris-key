// @pkey-feature ui.kit identity.link
//
// The link offer after a redirect sign-in (I-46.13): once the app runs and a redirect sign-in
// landed, `<PolarisKeyGate>` asks `link.offer()` and shows the offer over the app. Link goes to
// Done or the conflict; No thanks is stored and closes. Nothing shows without a pending sign-in,
// a Google entry, or after a decline.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { PolarisKeyProvider } from "@polaris-key/react";
import { PolarisKeyGate } from "@polaris-key/react/kit";
import type { LinkAcceptResult, LinkOfferResult } from "../src/core/index.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import { stubResizeObserver } from "./autoFixtures.js";
import { NOW_SEC, makeFakeBridge, okBridgeState } from "./fixtures.js";

beforeAll(stubResizeObserver);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Over = {
  pending?: boolean;
  offer?: LinkOfferResult;
  accept?: LinkAcceptResult;
  declined?: boolean;
};

const DONE: LinkAcceptResult = {
  kind: "linked",
  linked: { kind: "google", reach: null },
};

const OFFER: LinkOfferResult = {
  kind: "ok",
  offer: [
    { kind: "google", reach: "global" },
    { kind: "apple", reach: null },
  ],
};

/** The gate over a licensed desktop adapter whose `link` is the one under test. */
function mount(over: Over = {}) {
  const adapter = desktopAdapter({
    bridge: makeFakeBridge(okBridgeState()),
    now: () => NOW_SEC,
  });
  const link = {
    pending: vi.fn(() => over.pending ?? true),
    offer: vi.fn(async () => over.offer ?? OFFER),
    declined: vi.fn(async () => over.declined ?? false),
    accept: vi.fn(async (): Promise<LinkAcceptResult> => over.accept ?? DONE),
    decline: vi.fn(async () => undefined),
  };
  Object.assign(adapter, { link });
  const rendered = render(
    <PolarisKeyProvider config={{ productSlug: "acme", adapter }}>
      <PolarisKeyGate theme={{ product: { name: "Acme" } }}>
        <p data-testid="app">APP</p>
      </PolarisKeyGate>
    </PolarisKeyProvider>,
  );
  return { adapter, link, ...rendered };
}

const button = (root: HTMLElement, key: string): HTMLButtonElement | null =>
  root.querySelector(`button[data-key="${key}"]`);
const appears = (m: { container: HTMLElement }, key: string) =>
  waitFor(() => expect(button(m.container, key)).toBeTruthy());

describe("the link offer after a redirect sign-in", () => {
  it("shows over the app, and Link ends on Done", async () => {
    const m = mount();
    await appears(m, "signin.linkOffer.primary");
    expect(button(m.container, "signin.linkOffer.decline")).not.toBeNull();
    expect(m.container.querySelector('[data-testid="app"]')).not.toBeNull();
    fireEvent.click(button(m.container, "signin.linkOffer.primary")!);
    await appears(m, "common.continue");
    expect(m.link.accept).toHaveBeenCalledTimes(1);
    fireEvent.click(button(m.container, "common.continue")!);
    await waitFor(() =>
      expect(button(m.container, "common.continue")).toBeNull(),
    );
  });

  it("a conflict says so, points to Help, and ends on Continue", async () => {
    const m = mount({
      accept: { kind: "refused", status: 409, code: "link_conflict" },
    });
    await appears(m, "signin.linkOffer.primary");
    fireEvent.click(button(m.container, "signin.linkOffer.primary")!);
    await appears(m, "signin.linkOffer.join");
    expect(button(m.container, "common.continue")).not.toBeNull();
  });

  it("No thanks is remembered and closes the offer", async () => {
    const m = mount();
    await appears(m, "signin.linkOffer.decline");
    fireEvent.click(button(m.container, "signin.linkOffer.decline")!);
    await waitFor(() => expect(m.link.decline).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(button(m.container, "signin.linkOffer.primary")).toBeNull(),
    );
    expect(m.link.accept).not.toHaveBeenCalled();
  });

  it("a failed link keeps the offer, and Link tries again", async () => {
    const m = mount({ accept: { kind: "unavailable" } });
    await appears(m, "signin.linkOffer.primary");
    fireEvent.click(button(m.container, "signin.linkOffer.primary")!);
    await waitFor(() => expect(m.link.accept).toHaveBeenCalledTimes(1));
    await appears(m, "signin.linkOffer.primary");
    fireEvent.click(button(m.container, "signin.linkOffer.primary")!);
    await waitFor(() => expect(m.link.accept).toHaveBeenCalledTimes(2));
  });

  it("shows nothing without a pending sign-in, a Google entry, or after a decline", async () => {
    for (const over of [
      { pending: false },
      {
        offer: { kind: "ok", offer: [{ kind: "apple", reach: null }] } as const,
      },
      { offer: { kind: "ok", offer: [] } as const },
      { offer: { kind: "unavailable" } as const },
      { declined: true },
    ]) {
      const m = mount(over);
      await waitFor(() =>
        expect(m.container.querySelector('[data-testid="app"]')).not.toBeNull(),
      );
      await new Promise((r) => setTimeout(r, 30));
      expect(button(m.container, "signin.linkOffer.primary")).toBeNull();
      cleanup();
    }
  });
});
