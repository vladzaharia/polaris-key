/**
 * P2-07 — the Channels panel and the release policy actions in the Releases view.
 *
 * The panel renders the admin model as it is: what each channel serves on each platform comes
 * from the server's `byPlatform`, never from a rule the console re-implements. Every action opens
 * a confirmation stating its effect, sends exactly one request to P2-05's admin route, and
 * refreshes the store and the channels on success.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ChannelPolicyBody,
  ProductDetail,
  ReleaseChannelsResponse,
  ReleaseHealth,
  ReleaseStoreResponse,
} from "../src/api.js";
import { ApiError } from "../src/api.js";
import { resetCache } from "../src/context.js";
import { Toaster } from "../src/components/ui/index.js";
import { CHANNELS, SLUG, STORE } from "./releaseFixture.js";

const product = vi.fn<(slug: string) => Promise<{ product: ProductDetail }>>();
const releaseHealth =
  vi.fn<(slug: string) => Promise<{ health: ReleaseHealth }>>();
const releases = vi.fn<(slug: string) => Promise<ReleaseStoreResponse>>();
const releaseChannels =
  vi.fn<(slug: string) => Promise<ReleaseChannelsResponse>>();
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
const yankRelease =
  vi.fn<
    (slug: string, releaseId: string, reason: string) => Promise<unknown>
  >();
const unyankRelease =
  vi.fn<(slug: string, releaseId: string) => Promise<unknown>>();

vi.mock("../src/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api.js")>()),
  api: {
    product: (slug: string) => product(slug),
    resyncProduct: vi.fn(),
    releaseHealth: (slug: string) => releaseHealth(slug),
    releases: (slug: string) => releases(slug),
    releaseChannels: (slug: string) => releaseChannels(slug),
    updateReleaseChannel: (s: string, c: string, b: ChannelPolicyBody) =>
      updateReleaseChannel(s, c, b),
    revertReleaseChannel: (s: string, c: string, d?: string) =>
      revertReleaseChannel(s, c, d),
    setChannelFloor: (s: string, c: string, b: unknown) =>
      setChannelFloor(s, c, b),
    yankRelease: (s: string, r: string, reason: string) =>
      yankRelease(s, r, reason),
    unyankRelease: (s: string, r: string) => unyankRelease(s, r),
  },
}));

const { Releases } = await import("../src/views/Releases.js");

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

const HEALTH: ReleaseHealth = {
  status: "healthy",
  healthy: true,
  missing: [],
  checks: [],
};

beforeEach(() => {
  resetCache();
  for (const m of [
    product,
    releaseHealth,
    releases,
    releaseChannels,
    updateReleaseChannel,
    revertReleaseChannel,
    setChannelFloor,
    yankRelease,
    unyankRelease,
  ])
    m.mockReset();
  product.mockResolvedValue({ product: PRODUCT });
  releaseHealth.mockResolvedValue({ health: HEALTH });
  releases.mockResolvedValue(STORE);
  releaseChannels.mockResolvedValue(CHANNELS);
  for (const m of [
    updateReleaseChannel,
    revertReleaseChannel,
    setChannelFloor,
    yankRelease,
    unyankRelease,
  ])
    m.mockResolvedValue({ ok: true });
  // jsdom lacks these Radix-needed APIs.
  (
    Element.prototype as unknown as { hasPointerCapture: () => boolean }
  ).hasPointerCapture = () => false;
  (
    Element.prototype as unknown as { scrollIntoView: () => void }
  ).scrollIntoView = () => undefined;
});
afterEach(cleanup);

function renderView() {
  return render(
    <Toaster>
      <Releases slug={SLUG} />
    </Toaster>,
  );
}

/** The channels panel's row for `channel`, once the model has loaded. */
async function channelRow(channel: string): Promise<HTMLElement> {
  const list = await screen.findByRole("list", {
    name: `${channel} per platform`,
  });
  return list.closest("tr")!;
}

async function openMenu(channel: string, item: string): Promise<HTMLElement> {
  await channelRow(channel);
  await userEvent.click(
    screen.getByRole("button", { name: `Actions for ${channel}` }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
  return screen.findByRole("alertdialog");
}

async function pickRelease(dialog: HTMLElement, version: string) {
  await userEvent.click(within(dialog).getByRole("combobox"));
  await userEvent.click(await screen.findByRole("option", { name: version }));
}

/** Both readers of the store were asked again: the view refreshed after the change. */
async function expectRefreshed(): Promise<void> {
  await waitFor(() => {
    expect(releases.mock.calls.length).toBeGreaterThan(1);
    expect(releaseChannels.mock.calls.length).toBeGreaterThan(1);
  });
}

describe("Channels panel — what each channel serves", () => {
  it("renders a per-platform resolved release that differs where the newest release lacks a build", async () => {
    renderView();
    const stable = await channelRow("stable");
    const perPlatform = within(stable).getByRole("list", {
      name: "stable per platform",
    });
    const items = within(perPlatform)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    // v0.4.2 has no iOS build, so iOS stays on v0.4.1 — the server's answer, rendered as is.
    expect(items).toEqual([
      "Android→0.4.2",
      "iOS / iPadOS→0.4.1",
      "Linux→0.4.2",
      "macOS→0.4.2",
      "Web→0.4.2",
      "Windows→0.4.2",
    ]);
    expect(releaseChannels).toHaveBeenCalledWith(SLUG);
  });

  it("shows pointer, pin, includes, minimum, critical, rollback floor, source and last change", async () => {
    renderView();
    const beta = await channelRow("beta");
    expect(within(beta).getByText("pinned")).toBeTruthy();
    expect(within(beta).getByText("stable")).toBeTruthy();
    expect(within(beta).getByText("0.4.0")).toBeTruthy();
    expect(within(beta).getByText("critical")).toBeTruthy();
    expect(within(beta).getByText("admin")).toBeTruthy();
    expect(within(beta).getByText(/admin:u1/)).toBeTruthy();

    const stable = await channelRow("stable");
    expect(within(stable).getByText("newest")).toBeTruthy();
    expect(within(stable).getByText("default")).toBeTruthy();
    expect(within(stable).getByText("manifest")).toBeTruthy();
    // The anti-rollback floor (P0-02) sits on the stable row.
    expect(within(stable).getAllByText("0.4.2").length).toBeGreaterThan(0);
  });

  it("offers Revert to manifest only on an operator-owned row", async () => {
    renderView();
    await channelRow("stable");
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for stable" }),
    );
    await screen.findByRole("menuitem", { name: "Promote a release…" });
    expect(
      screen.queryByRole("menuitem", { name: "Revert to manifest" }),
    ).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Unpin" })).toBeNull();
    await userEvent.keyboard("{Escape}");

    await userEvent.click(
      screen.getByRole("button", { name: "Actions for beta" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Revert to manifest" }),
    ).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Unpin" })).toBeTruthy();
    // beta has no rollback floor, so the floor actions are not offered on it.
    expect(
      screen.queryByRole("menuitem", { name: "Lower rollback floor…" }),
    ).toBeNull();
  });
});

describe("Channel actions — one confirmed request each", () => {
  it("promote sends the chosen release as the pointer and refreshes", async () => {
    renderView();
    const dialog = await openMenu("stable", "Promote a release…");
    // A yanked release is not offered for promotion.
    await userEvent.click(within(dialog).getByRole("combobox"));
    expect(screen.queryByRole("option", { name: /0\.4\.0/ })).toBeNull();
    await userEvent.click(await screen.findByRole("option", { name: "0.4.1" }));
    expect(
      within(dialog).getByText(/0\.4\.1 becomes a member of stable/),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Promote" }),
    );
    await waitFor(() =>
      expect(updateReleaseChannel).toHaveBeenCalledWith(SLUG, "stable", {
        deliverable: "app",
        pointer: "v0.4.1",
      }),
    );
    await expectRefreshed();
  });

  it("pin states its effect and sends pointer + pinned; a yanked release may be pinned", async () => {
    renderView();
    const dialog = await openMenu("stable", "Pin to a release…");
    await pickRelease(dialog, "0.4.0 (yanked)");
    expect(
      within(dialog).getByText(
        /stable will serve 0\.4\.0 on every platform that has a build; newer releases are ignored until you unpin/,
      ),
    ).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Pin" }));
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
    renderView();
    const dialog = await openMenu("beta", "Unpin");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Unpin" }),
    );
    await waitFor(() =>
      expect(updateReleaseChannel).toHaveBeenCalledWith(SLUG, "beta", {
        deliverable: "app",
        pinned: false,
      }),
    );
    await expectRefreshed();
  });

  it("set minimum supported sends the version, and an emptied field removes it", async () => {
    renderView();
    let dialog = await openMenu("stable", "Set minimum supported…");
    const input = within(dialog).getByLabelText("Minimum supported version");
    // Unchanged (empty → empty) is not a change.
    expect(
      within(dialog)
        .getByRole("button", { name: "Remove minimum" })
        .hasAttribute("disabled"),
    ).toBe(true);
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
    const prefilled = within(dialog).getByLabelText(
      "Minimum supported version",
    ) as HTMLInputElement;
    expect(prefilled.value).toBe("0.4.0");
    await userEvent.clear(prefilled);
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

  it("toggling critical sends the flipped flag", async () => {
    renderView();
    let dialog = await openMenu("stable", "Mark critical");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Mark critical" }),
    );
    await waitFor(() =>
      expect(updateReleaseChannel).toHaveBeenCalledWith(SLUG, "stable", {
        deliverable: "app",
        critical: true,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    dialog = await openMenu("beta", "Clear critical");
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
    renderView();
    const dialog = await openMenu("beta", "Revert to manifest");
    expect(
      within(dialog).getByText(/re-applies on the\s+next resync/),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Revert to manifest" }),
    );
    await waitFor(() =>
      expect(revertReleaseChannel).toHaveBeenCalledWith(SLUG, "beta", "app"),
    );
    await expectRefreshed();
  });

  it("lowers and clears the rollback floor through the floor route", async () => {
    renderView();
    let dialog = await openMenu("stable", "Lower rollback floor…");
    const lower = within(dialog).getByRole("button", { name: "Lower floor" });
    expect(lower.hasAttribute("disabled")).toBe(true);
    await userEvent.type(
      within(dialog).getByLabelText("Lower the floor to"),
      "0.4.1",
    );
    await userEvent.click(lower);
    await waitFor(() =>
      expect(setChannelFloor).toHaveBeenCalledWith(SLUG, "stable", {
        version: "0.4.1",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    dialog = await openMenu("stable", "Clear rollback floor");
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
    renderView();
    await userEvent.click(
      await screen.findByRole("button", { name: "Clear nightly floor" }),
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
});

describe("Release actions — yank and unyank", () => {
  it("yank refuses an empty reason, then sends the reason and refreshes", async () => {
    renderView();
    await userEvent.click(
      await screen.findByRole("button", { name: "Yank 0.4.2" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/resolves only through an explicit pin/),
    ).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "Yank" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    // Whitespace is not a reason.
    const reason = within(dialog).getByLabelText("Reason (required)");
    await userEvent.type(reason, "   ");
    expect(confirm.hasAttribute("disabled")).toBe(true);
    await userEvent.click(confirm);
    expect(yankRelease).not.toHaveBeenCalled();

    await userEvent.type(reason, "crashes on launch");
    expect(confirm.hasAttribute("disabled")).toBe(false);
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(yankRelease).toHaveBeenCalledWith(
        SLUG,
        "v0.4.2",
        "crashes on launch",
      ),
    );
    await expectRefreshed();
  });

  it("unyank sends DELETE for a yanked release", async () => {
    renderView();
    await userEvent.click(
      await screen.findByRole("button", { name: "Unyank 0.4.0" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Unyank" }),
    );
    await waitFor(() =>
      expect(unyankRelease).toHaveBeenCalledWith(SLUG, "v0.4.0"),
    );
    await expectRefreshed();
  });

  it("a refusal keeps the dialog open and toasts the console's wording for its reason", async () => {
    updateReleaseChannel.mockRejectedValue(
      new ApiError(
        409,
        ["releaseId"],
        "bad_request",
        undefined,
        "release_yanked",
      ),
    );
    renderView();
    const dialog = await openMenu("stable", "Promote a release…");
    await pickRelease(dialog, "0.4.1");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Promote" }),
    );
    expect(
      await screen.findByText(
        "A yanked release cannot be promoted. Unyank it, or pin it explicitly.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(releases).toHaveBeenCalledTimes(1);
  });
});
