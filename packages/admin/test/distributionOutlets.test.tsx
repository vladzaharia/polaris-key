/**
 * Distribution → Outlets & feeds (admin chunk 9, ADMIN.md §6.4): the outlets table, the routed
 * outlet drawer with capabilities (narrow only; revert to the kind default), the storefront feed
 * URLs and the distribution key inventory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { resetConsole } from "./consoleHarness.js";
import {
  apiError,
  bootWith,
  OUTLETS,
  P,
  writes,
} from "./distributionFixture.js";

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});
const HASH = "#/p/djdl/distribution/outlets";

beforeEach(() => resetConsole());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function outlets(): Promise<HTMLElement> {
  const t = await screen.findByRole("table", { name: "Outlets" });
  await within(t).findByText("altstore");
  return t;
}

describe("Distribution → Outlets & feeds", () => {
  it("lists the declared outlets with kind, capabilities and feeds", async () => {
    bootWith(HASH);
    const t = await outlets();
    expect(
      screen.getByRole("heading", { level: 1, name: "Outlets & feeds" }),
    ).toBeTruthy();
    expect(within(t).getByText("App Store")).toBeTruthy();
    // The `direct` kind reads "Polaris Key" (S-21 §6.8); its id stays `direct`.
    expect(within(t).getByText("Polaris Key")).toBeTruthy();
    expect(within(t).getByText("direct")).toBeTruthy();
    expect(within(t).queryByText(/direct download/i)).toBeNull();
    expect(within(t).getByText("Narrowed in console")).toBeTruthy();
    expect(within(t).getByText(/AltStore source · 2 channels/)).toBeTruthy();
    expect(within(t).getByText(/apple-ba/)).toBeTruthy();
  });

  it("opens an outlet in a drawer routed by ?outlet= with its feed URLs", async () => {
    bootWith(`${HASH}?outlet=altstore`);
    const drawer = await screen.findByRole("dialog", { name: "altstore" });
    const urls = within(drawer).getByRole("list", {
      name: "AltStore source URLs",
    });
    expect(
      within(urls).getByText(
        /\/djdl\/distribution\/altstore\/stable\/source\.json$/,
      ),
    ).toBeTruthy();
    expect(
      within(urls).getByText(
        /\/djdl\/distribution\/altstore\/beta\/source\.json$/,
      ),
    ).toBeTruthy();
    expect(
      within(drawer).getByRole("button", {
        name: "Copy the stable AltStore source URL",
      }),
    ).toBeTruthy();
  });

  it("names a missing outlet instead of a blank drawer", async () => {
    bootWith(`${HASH}?outlet=nowhere`);
    expect(await screen.findByText("No outlet nowhere")).toBeTruthy();
  });

  it("narrows capabilities below the kind default, after a review", async () => {
    const { calls } = bootWith(`${HASH}?outlet=direct`, {
      [`PUT ${P("/distribution/outlets/direct/capabilities")}`]: {
        outlet: OUTLETS.outlets[0],
      },
    });
    const drawer = await screen.findByRole("dialog", { name: "direct" });
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Narrow capabilities…" }),
    );
    const narrow = await screen.findByRole("dialog", { name: "Narrow direct" });
    await userEvent.click(
      within(narrow).getByRole("combobox", { name: /Code updates/ }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Not allowed" }),
    );
    await userEvent.click(
      within(narrow).getByRole("button", { name: "Review narrowing…" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    expect(
      within(confirm).getByText("Code updates: Allowed → Not allowed"),
    ).toBeTruthy();
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Narrow capabilities" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toContainEqual(
        expect.objectContaining({
          path: P("/distribution/outlets/direct/capabilities"),
          method: "PUT",
          body: { capabilities: { codeUpdates: false } },
        }),
      ),
    );
  });

  it("reverts a narrowed outlet to the manifest from its source badge", async () => {
    const { calls } = bootWith(`${HASH}?outlet=play`, {
      [`POST ${P("/distribution/outlets/play/capabilities/revert")}`]: {
        outlet: OUTLETS.outlets[2],
      },
    });
    const drawer = await screen.findByRole("dialog", { name: "play" });
    expect(
      within(drawer).getByText("Kind default: Store in-app purchase"),
    ).toBeTruthy();
    await userEvent.click(
      within(drawer).getByRole("button", { name: /Set in console/ }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Revert/ }),
    );
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Revert to manifest" }),
    );
    await waitFor(() =>
      expect(writes(calls).map((c) => c.path)).toContain(
        P("/distribution/outlets/play/capabilities/revert"),
      ),
    );
  });

  it("round-trips the kind facet in a namespaced URL key", async () => {
    bootWith(`${HASH}?outlets.kind=play`);
    const t = await screen.findByRole("table", { name: "Outlets" });
    await waitFor(() => expect(within(t).getAllByRole("row")).toHaveLength(2));
    expect(within(t).getByText("play")).toBeTruthy();
  });

  it("explains outlets when none are declared, and shows load errors with Retry", async () => {
    bootWith(HASH, {
      [P("/distribution/outlets")]: { ...OUTLETS, outlets: [] },
    });
    expect(await screen.findByText("No outlets declared")).toBeTruthy();
    cleanup();
    resetConsole();
    let fail = true;
    bootWith(HASH, {
      [P("/distribution/outlets")]: () =>
        fail ? apiError(500, "internal") : OUTLETS,
    });
    const retry = (await screen.findAllByRole("button", { name: "Retry" }))[0]!;
    fail = false;
    await userEvent.click(retry);
    expect(await outlets()).toBeTruthy();
  });

  describe("distribution keys", () => {
    it("lists the inventory and CI's unmatched observations", async () => {
      bootWith(HASH);
      const keys = await screen.findByRole("table", {
        name: "Distribution keys",
      });
      expect(await within(keys).findByText("Android app signing")).toBeTruthy();
      expect(screen.getByText("Keys CI saw that match no entry")).toBeTruthy();
      expect(screen.getByText("Android upload")).toBeTruthy();
    });

    it("adds a key, normalising the fingerprint", async () => {
      const { calls } = bootWith(HASH, {
        [`PUT ${P("/distribution/keys")}`]: {
          purposes: [],
          keys: [],
          observations: [],
        },
      });
      await screen.findByRole("table", { name: "Distribution keys" });
      await userEvent.click(screen.getByRole("button", { name: "Add key…" }));
      const drawer = await screen.findByRole("dialog", { name: "Add key" });
      const input = within(drawer).getByLabelText(/SHA-256 fingerprint/);
      await userEvent.type(input, "not-hex");
      await userEvent.click(
        within(drawer).getByRole("button", { name: "Save key" }),
      );
      expect(
        await within(drawer).findByText(/64 hex characters of the SHA-256/),
      ).toBeTruthy();
      await userEvent.clear(input);
      await userEvent.type(input, "AB:".repeat(31) + "cd");
      await userEvent.click(
        within(drawer).getByRole("button", { name: "Save key" }),
      );
      await waitFor(() =>
        expect(writes(calls)).toContainEqual(
          expect.objectContaining({
            path: P("/distribution/keys"),
            method: "PUT",
            body: expect.objectContaining({
              purpose: "android-app-signing",
              sha256: "ab".repeat(31) + "cd",
            }),
          }),
        ),
      );
    });

    it("dismisses an observation after a caution confirm", async () => {
      const { calls } = bootWith(HASH, {
        [`DELETE ${P(`/distribution/keys/android-upload/${"b".repeat(64)}`)}`]:
          {
            purposes: [],
            keys: [],
            observations: [],
          },
      });
      await screen.findByText("Keys CI saw that match no entry");
      await userEvent.click(screen.getByRole("button", { name: "Dismiss…" }));
      const confirm = await screen.findByRole("alertdialog");
      await userEvent.click(
        within(confirm).getByRole("button", { name: "Dismiss" }),
      );
      await waitFor(() =>
        expect(writes(calls)).toContainEqual(
          expect.objectContaining({
            method: "DELETE",
            path: P(`/distribution/keys/android-upload/${"b".repeat(64)}`),
          }),
        ),
      );
    });
  });

  it("passes axe", async () => {
    bootWith(HASH);
    await outlets();
    const results = await axe(document.body);
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      ),
    ).toEqual([]);
  });
});
