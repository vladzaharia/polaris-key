/**
 * Release → Channels (ADMIN.md §6.3.3): the lane view and every channel policy action.
 *
 * Each lane renders the admin model as it is: what a channel serves per platform is the server's
 * `byPlatform`, never a rule the console re-implements. Every action opens a confirmation at its
 * §5.2 level stating its effect, sends exactly one request, and refreshes the store and the
 * channels on success.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ChannelPolicyBody,
  PackReleasesResponse,
  ProductDetail,
  ReleaseChannelsResponse,
  ReleaseStoreResponse,
} from "../src/api.js";
import { ApiError } from "../src/api.js";
import { confirmFor } from "../src/lib/actions.js";
import { actionIdOf } from "../src/console/sections/release/components/PolicyDialog.js";
import { CHANNELS, SLUG, STORE } from "./releaseFixture.js";
import {
  expectNoAxeViolations,
  hashQuery,
  mountAt,
  pending,
} from "./releaseHarness.js";

const product = vi.fn<(slug: string) => Promise<{ product: ProductDetail }>>();
const releases = vi.fn<(slug: string) => Promise<ReleaseStoreResponse>>();
const releaseChannels =
  vi.fn<(slug: string) => Promise<ReleaseChannelsResponse>>();
const packReleases =
  vi.fn<(slug: string, id: string) => Promise<PackReleasesResponse>>();
const updateReleaseChannel =
  vi.fn<
    (slug: string, channel: string, body: ChannelPolicyBody) => Promise<unknown>
  >();
const revertReleaseChannel =
  vi.fn<
    (slug: string, channel: string, deliverable?: string) => Promise<unknown>
  >();
const setChannelFloor =
  vi.fn<(slug: string, channel: string, body: unknown) => Promise<unknown>>();

vi.mock("../src/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api.js")>()),
  api: {
    product: (slug: string) => product(slug),
    releases: (slug: string) => releases(slug),
    releaseChannels: (slug: string) => releaseChannels(slug),
    packReleases: (s: string, id: string) => packReleases(s, id),
    updateReleaseChannel: (s: string, c: string, b: ChannelPolicyBody) =>
      updateReleaseChannel(s, c, b),
    revertReleaseChannel: (s: string, c: string, d?: string) =>
      revertReleaseChannel(s, c, d),
    setChannelFloor: (s: string, c: string, b: unknown) =>
      setChannelFloor(s, c, b),
  },
}));

const { ChannelsPage } =
  await import("../src/console/sections/release/pages/ChannelsPage.js");

const PRODUCT: ProductDetail = {
  slug: SLUG,
  name: "Diceroll",
  signingKid: "kid-2026",
  compatMin: "0.0.0",
  compatMax: "",
  defaultMaxOfflineDays: 14,
  defaultDeviceLimit: 3,
  adminGroup: null,
  releaseSource: "github",
  createdAt: 1_700_000_000,
  modifiedAt: 1_710_000_000,
};

/** The fixture's app channels plus one pack, `textures`, with a contentApi floor. */
const WITH_PACK: ReleaseChannelsResponse = {
  deliverables: [
    ...CHANNELS.deliverables,
    {
      deliverable: "textures",
      kind: "pack",
      platforms: [],
      channels: [
        {
          deliverable: "textures",
          channel: "stable",
          pointer: null,
          pinned: false,
          includes: null,
          minSupported: null,
          critical: false,
          source: "manifest",
          modifiedAt: null,
          modifiedBy: null,
          resolved: "textures@1.3.0",
          byPlatform: {},
          packFloors: [
            {
              contentApi: 3,
              minSupported: "1.2.0",
              modifiedAt: 1_728_000_000,
              modifiedBy: "admin:u1",
            },
          ],
        },
      ],
    },
  ],
};

const PACK_RELEASES: PackReleasesResponse = {
  deliverable: "textures",
  releases: [
    {
      releaseId: "textures@1.3.0",
      version: "1.3.0",
      seq: 2,
      channel: "stable",
      publishedAt: 1_728_000_000,
      yank: null,
      recordSha256: null,
      formatVersion: 1,
      entitlement: null,
      variants: [],
      pinnedBy: [],
    },
  ],
};

beforeEach(() => {
  for (const m of [
    product,
    releases,
    releaseChannels,
    packReleases,
    updateReleaseChannel,
    revertReleaseChannel,
    setChannelFloor,
  ])
    m.mockReset();
  product.mockResolvedValue({ product: PRODUCT });
  releases.mockResolvedValue(STORE);
  releaseChannels.mockResolvedValue(CHANNELS);
  packReleases.mockResolvedValue(PACK_RELEASES);
  for (const m of [updateReleaseChannel, revertReleaseChannel, setChannelFloor])
    m.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

const HASH = `#/p/${SLUG}/release/channels`;

function mountPage(hash = HASH) {
  return mountAt(hash, <ChannelsPage slug={SLUG} />);
}

/** The lane for `channel`, once the model has loaded. */
async function lane(channel: string): Promise<HTMLElement> {
  return screen.findByRole("region", { name: channel });
}

async function openMenu(channel: string, item: string): Promise<HTMLElement> {
  const l = await lane(channel);
  await userEvent.click(
    within(l).getByRole("button", { name: `More actions for ${channel}` }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
  return screen.findByRole("alertdialog");
}

async function pickRelease(dialog: HTMLElement, version: string | RegExp) {
  await userEvent.click(
    within(dialog).getByRole("button", { name: /Release/ }),
  );
  await userEvent.click(
    await screen.findByRole("option", {
      name: typeof version === "string" ? new RegExp(`^${version}`) : version,
    }),
  );
}

/** Both readers of the store were asked again: the page refreshed after the change. */
async function expectRefreshed(): Promise<void> {
  await waitFor(() => {
    expect(releases.mock.calls.length).toBeGreaterThan(1);
    expect(releaseChannels.mock.calls.length).toBeGreaterThan(1);
  });
}

describe("Channels lanes — what each channel serves (CHN-2, CHN-4)", () => {
  it("renders the per-platform resolution, and says why a platform gets an older release", async () => {
    mountPage();
    const stable = await lane("stable");
    // Versions, not ids, once the store has loaded.
    await within(stable).findByText("Android 0.4.2");
    const perPlatform = within(stable).getByRole("list", {
      name: "What stable serves per platform",
    });
    const items = within(perPlatform)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    // v0.4.2 has no iOS build, so iOS stays on v0.4.1: the server's answer, with the reason.
    expect(items).toEqual([
      "Android 0.4.2",
      "iOS 0.4.1no iOS build in 0.4.2",
      "Linux 0.4.2",
      "macOS 0.4.2",
      "Web 0.4.2",
      "Windows 0.4.2",
    ]);
    expect(releaseChannels).toHaveBeenCalledWith(SLUG);
  });

  it("spells out pointer, pin, includes, policy, floor, source and last change", async () => {
    mountPage();
    const beta = await lane("beta");
    expect(within(beta).getByText("Pinned")).toBeTruthy();
    expect(within(beta).getByText("stable")).toBeTruthy();
    expect(within(beta).getByText("0.4.0")).toBeTruthy();
    expect(within(beta).getByText("Critical")).toBeTruthy();
    expect(within(beta).getByText("Set in console")).toBeTruthy();
    expect(within(beta).getByText(/by u1/)).toBeTruthy();

    const stable = await lane("stable");
    expect(within(stable).getByText(/Newest eligible release/)).toBeTruthy();
    expect(
      within(stable).getByText("No other channel (the default)"),
    ).toBeTruthy();
    expect(within(stable).getByText("From manifest")).toBeTruthy();
    // The anti-rollback floor (P0-02), with when it was raised (CHN-5).
    expect(within(stable).getByText(/Rollback floor/)).toBeTruthy();
    expect(within(stable).getByText(/raised/)).toBeTruthy();
    // Each lane links to Compatibility and the Matrix (CHN-6).
    expect(
      within(stable)
        .getByRole("link", { name: "Compatibility" })
        .getAttribute("href"),
    ).toBe(`#/p/${SLUG}/release/compatibility`);
  });

  it("offers Revert to manifest only on an operator-owned lane, and floor actions only with a floor", async () => {
    mountPage();
    const stable = await lane("stable");
    await userEvent.click(
      within(stable).getByRole("button", { name: "More actions for stable" }),
    );
    await screen.findByRole("menuitem", { name: "Pin to a release…" });
    expect(
      screen.queryByRole("menuitem", { name: "Revert to manifest…" }),
    ).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Unpin…" })).toBeNull();
    expect(
      screen.getByRole("menuitem", { name: "Lower rollback floor…" }),
    ).toBeTruthy();
    await userEvent.keyboard("{Escape}");

    const beta = await lane("beta");
    await userEvent.click(
      within(beta).getByRole("button", { name: "More actions for beta" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Revert to manifest…" }),
    ).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Unpin…" })).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: "Lower rollback floor…" }),
    ).toBeNull();
  });

  it("shows skeletons while loading, then an error with Retry", async () => {
    releaseChannels.mockReturnValueOnce(pending());
    const { container } = mountPage();
    await screen.findByRole("heading", { level: 1, name: "Channels" });
    expect(container.querySelector("[data-skeleton]")).toBeTruthy();
    cleanup();
    releaseChannels.mockReset();
    releaseChannels
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(CHANNELS);
    mountPage();
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await lane("stable")).toBeTruthy();
  });

  it("says what a channel is when there is none yet", async () => {
    releaseChannels.mockResolvedValue({ deliverables: [] });
    mountPage();
    expect(await screen.findByText("No channels yet")).toBeTruthy();
  });

  it("switches deliverables through the URL and shows a pack's floors per contentApi line (CHN-1)", async () => {
    releaseChannels.mockResolvedValue(WITH_PACK);
    mountPage();
    await lane("beta");
    await userEvent.click(screen.getByRole("radio", { name: "textures" }));
    await waitFor(() =>
      expect(hashQuery().get("deliverable")).toBe("textures"),
    );
    const stable = await lane("stable");
    expect(within(stable).getByText(/Content API 3: ≥/)).toBeTruthy();
    expect(within(stable).getByText("1.2.0")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "beta" })).toBeNull();
    // Promote on a pack lane offers the pack's releases.
    await userEvent.click(
      within(stable).getByRole("button", { name: "Promote…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await pickRelease(dialog, "1.3.0");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Promote 1.3.0" }),
    );
    await waitFor(() =>
      expect(updateReleaseChannel).toHaveBeenCalledWith(SLUG, "stable", {
        deliverable: "textures",
        pointer: "textures@1.3.0",
      }),
    );
  });

  it("changes and clears a pack floor for one contentApi line", async () => {
    releaseChannels.mockResolvedValue(WITH_PACK);
    mountPage(`${HASH}?deliverable=textures`);
    const stable = await lane("stable");
    await userEvent.click(
      within(stable).getAllByRole("button", { name: "Change…" }).at(-1)!,
    );
    let dialog = await screen.findByRole("alertdialog");
    const v = within(dialog).getByRole("textbox", {
      name: /Minimum pack version/,
    });
    expect((v as HTMLInputElement).value).toBe("1.2.0");
    await userEvent.clear(v);
    await userEvent.type(v, "1.2.5");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Set floor" }),
    );
    await waitFor(() =>
      expect(updateReleaseChannel).toHaveBeenCalledWith(SLUG, "stable", {
        deliverable: "textures",
        contentApi: 3,
        minSupported: "1.2.5",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await userEvent.click(
      within(stable).getAllByRole("button", { name: "Change…" }).at(-1)!,
    );
    dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("checkbox", { name: "Clear this line's floor" }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Clear floor" }),
    );
    await waitFor(() =>
      expect(updateReleaseChannel).toHaveBeenLastCalledWith(SLUG, "stable", {
        deliverable: "textures",
        contentApi: 3,
        minSupported: null,
      }),
    );
  });

  it("passes axe", async () => {
    const { container } = mountPage();
    await lane("stable");
    await expectNoAxeViolations(container);
  });
});

describe("Channel actions — one confirmed request each (CHN-3, PAD-1 to PAD-5)", () => {
  it("each action carries its §5.2 level", () => {
    const c = CHANNELS.deliverables[0]!.channels[0]!;
    expect(
      confirmFor(actionIdOf({ kind: "promote", deliverable: "app" })).intent,
    ).toBe("caution");
    expect(
      confirmFor(actionIdOf({ kind: "critical", channel: c })).intent,
    ).toBe("caution");
    expect(
      confirmFor(
        actionIdOf({ kind: "critical", channel: { ...c, critical: true } }),
      ).intent,
    ).toBe("caution");
    const floor = STORE.floors[0]!;
    expect(
      confirmFor(actionIdOf({ kind: "clearFloor", channel: "stable", floor }))
        .intent,
    ).toBe("danger");
    expect(
      confirmFor(actionIdOf({ kind: "lowerFloor", channel: "stable", floor }))
        .intent,
    ).toBe("danger");
  });

  it("promote, visible on the lane, sends the chosen release as the pointer and refreshes", async () => {
    mountPage();
    const stable = await lane("stable");
    await userEvent.click(
      within(stable).getByRole("button", { name: "Promote…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    // A yanked release is not offered for promotion; the picker shows channel and date (PAD-2).
    await userEvent.click(
      within(dialog).getByRole("button", { name: /Release/ }),
    );
    expect(screen.queryByRole("option", { name: /^0\.4\.0/ })).toBeNull();
    await userEvent.click(
      await screen.findByRole("option", { name: /^0\.4\.1/ }),
    );
    expect(
      within(dialog).getByText(
        /Promote moves the pointer; newer releases still flow/,
      ),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Promote 0.4.1" }),
    );
    await waitFor(() =>
      expect(updateReleaseChannel).toHaveBeenCalledWith(SLUG, "stable", {
        deliverable: "app",
        pointer: "v0.4.1",
      }),
    );
    await expectRefreshed();
  });

  it("pin states a different effect from promote (PAD-3); a yanked release may be pinned", async () => {
    mountPage();
    const dialog = await openMenu("stable", "Pin to a release…");
    await pickRelease(dialog, /^0\.4\.0/);
    expect(
      within(dialog).getByText("Pin freezes the channel at this release."),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Pin stable" }),
    );
    await waitFor(() =>
      expect(updateReleaseChannel).toHaveBeenCalledWith(SLUG, "stable", {
        deliverable: "app",
        pointer: "v0.4.0",
        pinned: true,
      }),
    );
    await expectRefreshed();
  });

  it("unpin sends pinned: false", async () => {
    mountPage();
    const dialog = await openMenu("beta", "Unpin…");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Unpin beta" }),
    );
    await waitFor(() =>
      expect(updateReleaseChannel).toHaveBeenCalledWith(SLUG, "beta", {
        deliverable: "app",
        pinned: false,
      }),
    );
    await expectRefreshed();
  });

  it("set minimum supported validates the version, and removing it is explicit (PAD-4)", async () => {
    mountPage();
    let dialog = await openMenu("stable", "Set minimum supported…");
    const input = within(dialog).getByRole("textbox", {
      name: /Minimum supported version/,
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Set minimum" }),
    );
    expect(await within(dialog).findByText("Enter a version.")).toBeTruthy();
    await userEvent.type(input, "not-a-version");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Set minimum" }),
    );
    expect(
      await within(dialog).findByText("Use a version such as 2.0.0."),
    ).toBeTruthy();
    expect(updateReleaseChannel).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, "0.4.1");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Set minimum" }),
    );
    await waitFor(() =>
      expect(updateReleaseChannel).toHaveBeenCalledWith(SLUG, "stable", {
        deliverable: "app",
        minSupported: "0.4.1",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    dialog = await openMenu("beta", "Set minimum supported…");
    const prefilled = within(dialog).getByRole("textbox", {
      name: /Minimum supported version/,
    }) as HTMLInputElement;
    expect(prefilled.value).toBe("0.4.0");
    await userEvent.click(
      within(dialog).getByRole("checkbox", {
        name: "Remove the minimum supported version",
      }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove minimum" }),
    );
    await waitFor(() =>
      expect(updateReleaseChannel).toHaveBeenLastCalledWith(SLUG, "beta", {
        deliverable: "app",
        minSupported: null,
      }),
    );
  });

  it("the inline affordances open the same dialogs (CHN-3)", async () => {
    mountPage();
    const stable = await lane("stable");
    await userEvent.click(within(stable).getByRole("button", { name: "Set…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Set stable's minimum supported version"),
    ).toBeTruthy();
  });

  it("toggling critical sends the flipped flag, as a caution, not destructive (PAD-5)", async () => {
    mountPage();
    let dialog = await openMenu("stable", "Mark critical…");
    const mark = within(dialog).getByRole("button", { name: "Mark critical" });
    expect(mark.className).not.toMatch(/bg-danger/);
    await userEvent.click(mark);
    await waitFor(() =>
      expect(updateReleaseChannel).toHaveBeenCalledWith(SLUG, "stable", {
        deliverable: "app",
        critical: true,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    dialog = await openMenu("beta", "Clear critical…");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Clear critical" }),
    );
    await waitFor(() =>
      expect(updateReleaseChannel).toHaveBeenLastCalledWith(SLUG, "beta", {
        deliverable: "app",
        critical: false,
      }),
    );
  });

  it("revert explains the next-resync semantics and posts the deliverable", async () => {
    mountPage();
    const dialog = await openMenu("beta", "Revert to manifest…");
    expect(
      within(dialog).getByText(/re-applies on the next resync/),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Revert to manifest" }),
    );
    await waitFor(() =>
      expect(revertReleaseChannel).toHaveBeenCalledWith(SLUG, "beta", "app"),
    );
    await expectRefreshed();
  });

  it("lowers and clears the rollback floor through the floor route, as danger confirms", async () => {
    mountPage();
    let dialog = await openMenu("stable", "Lower rollback floor…");
    const lower = within(dialog).getByRole("button", { name: "Lower floor" });
    expect(lower.className).toMatch(/bg-danger/);
    await userEvent.click(lower);
    expect(setChannelFloor).not.toHaveBeenCalled();
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /Lower the floor to/ }),
      "0.4.1",
    );
    await userEvent.click(lower);
    await waitFor(() =>
      expect(setChannelFloor).toHaveBeenCalledWith(SLUG, "stable", {
        version: "0.4.1",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    dialog = await openMenu("stable", "Clear rollback floor…");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Clear floor" }),
    );
    await waitFor(() =>
      expect(setChannelFloor).toHaveBeenLastCalledWith(SLUG, "stable", {
        clear: true,
      }),
    );
    await expectRefreshed();
  });

  it("a stranded floor (its channel no longer served) can still be cleared", async () => {
    releases.mockResolvedValue({
      ...STORE,
      floors: [
        ...STORE.floors,
        {
          channel: "nightly",
          version: "9.9.9",
          releaseId: null,
          raisedAt: 1_700_000_000,
          loweredBy: null,
          loweredAt: null,
        },
      ],
    });
    mountPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "Clear nightly floor…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Clear floor" }),
    );
    await waitFor(() =>
      expect(setChannelFloor).toHaveBeenCalledWith(SLUG, "nightly", {
        clear: true,
      }),
    );
  });

  it("a refusal keeps the dialog open with the console's wording for its reason", async () => {
    updateReleaseChannel.mockRejectedValue(
      new ApiError(
        409,
        ["releaseId"],
        "bad_request",
        undefined,
        "release_yanked",
      ),
    );
    mountPage();
    const stable = await lane("stable");
    await userEvent.click(
      within(stable).getByRole("button", { name: "Promote…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await pickRelease(dialog, "0.4.1");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Promote 0.4.1" }),
    );
    expect(
      await within(dialog).findByText(
        "A yanked release cannot be promoted. Unyank it, or pin it explicitly.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(releases).toHaveBeenCalledTimes(1);
  });
});
