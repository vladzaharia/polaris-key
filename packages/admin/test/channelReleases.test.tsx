/**
 * A-22.2: a channel's Releases tab: the rollouts of that store's outlets only, with the same
 * row actions and dialogs as Distribution → Rollouts.
 */

import userEvent from "@testing-library/user-event";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootWith, P, ROLLOUTS } from "./distributionFixture.js";
import { resetConsole } from "./consoleHarness.js";
import type { ChannelRow, ChannelsView } from "../src/api.js";
import { outletIdsOf } from "../src/console/sections/distribution/components/ChannelReleases.js";

beforeEach(() => resetConsole());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const H = "#/p/djdl/distribution/channels";

const channel = (over: Partial<ChannelRow>): ChannelRow => ({
  id: "polaris-key",
  label: "Polaris Locker",
  inScope: true,
  declared: true,
  oneClick: false,
  notUsing: false,
  delivery: { state: "live", attention: [], platforms: [] },
  commerce: null,
  identity: null,
  ...over,
});

const channels = (c: ChannelRow): ChannelsView => ({
  product: "djdl",
  now: 1,
  platforms: [],
  kinds: [],
  channels: [c],
});

const boot = (id: string, c: ChannelRow, extra: Record<string, unknown> = {}) =>
  bootWith(`${H}/${id}/releases`, {
    [P("/distribution/channels")]: channels(c),
    ...extra,
  });

/** The loaded rollouts table: its rows arrive with the data, versions with Release's store. */
async function loaded(): Promise<HTMLElement> {
  const t = await screen.findByRole("table", { name: "Rollouts" });
  await within(t).findAllByRole("link", { name: "2.4.0" });
  return t;
}

describe("Distribution → a channel: Releases", () => {
  it("lists this store's rollouts only", async () => {
    boot("polaris-key", channel({}));
    const t = await loaded();
    // direct has two rollouts (stable, beta); play and altstore are other channels.
    expect(within(t).getAllByRole("row")).toHaveLength(3);
    expect(within(t).queryByText("play")).toBeNull();
    expect(within(t).queryByText("altstore")).toBeNull();
  });

  it("a mirrored store rollout is read-only in the row menu", async () => {
    boot("google-play", channel({ id: "google-play", label: "Google Play" }));
    const t = await loaded();
    expect(within(t).getAllByRole("row")).toHaveLength(2);
    await userEvent.click(
      within(t).getByRole("button", { name: /^Actions for / }),
    );
    expect(screen.queryByRole("menuitem", { name: /Pause/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Open rollout" })).toBeTruthy();
  });

  it("is a skeleton while loading", async () => {
    boot("polaris-key", channel({}), {
      [P("/distribution/rollouts")]: () => new Promise(() => undefined),
    });
    expect(await screen.findByRole("heading", { level: 1 })).toBeTruthy();
    expect(screen.queryByRole("row", { name: /2\.4\.0/ })).toBeNull();
    expect(
      screen
        .getByRole("tab", { name: "Releases" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("is an empty state when the store has no rollout", async () => {
    boot("polaris-key", channel({}), {
      [P("/distribution/rollouts")]: {
        rollouts: ROLLOUTS.rollouts.slice(1, 2),
      },
    });
    expect(await screen.findByText("No rollouts yet")).toBeTruthy();
    expect(screen.getByText(/No rollout on Polaris Locker yet/)).toBeTruthy();
  });

  it("opens the Start rollout and row dialogs from the tab", async () => {
    boot("polaris-key", channel({}));
    const t = await loaded();
    await userEvent.click(
      screen.getByRole("button", { name: "Start rollout…" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Start a rollout" }),
    ).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Start a rollout" }),
      ).toBeNull(),
    );
    await userEvent.click(
      within(t).getAllByRole("button", { name: /^Actions for / })[0]!,
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Resume…" }),
    );
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
  });
});

describe("outletIdsOf", () => {
  const o = (outletId: string, kind: string, over = {}) =>
    ({
      outletId,
      kind,
      identity: {},
      removedAt: null,
      ...over,
    }) as never;
  it("maps outlets to their channel, with a package manager's subkind, and drops removed ones", () => {
    const list = [
      o("direct", "direct"),
      o("brew", "direct", { identity: { homebrewCask: "djdl" } }),
      o("play", "play"),
      o("old", "play", { removedAt: 5 }),
    ];
    expect([...outletIdsOf(list, "polaris-key")]).toEqual(["direct"]);
    expect([...outletIdsOf(list, "homebrew")]).toEqual(["brew"]);
    expect([...outletIdsOf(list, "google-play")]).toEqual(["play"]);
  });
});
