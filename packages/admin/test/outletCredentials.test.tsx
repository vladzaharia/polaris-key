/**
 * Distribution → Channel credentials (admin chunk 9, ADMIN.md §6.4): moved from Keys and secrets
 * (the "Channel credentials card (P5-01)" suite lived in `secrets.test.tsx`). Write-only values,
 * pins, kind-first drawer, rotate, delete and the platform store connection's refusal (A-16). The
 * connector cards moved to a channel's Setup (A-22.3b). Closes OUT-1 to OUT-7.
 */

import { describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resetConsole } from "./consoleHarness.js";
import { expectNoAxeViolations } from "./coreTestUtils.js";
import { openSetDrawer, resetAround, VIEW_ONLY } from "./credentialsKit.js";
import {
  apiError,
  bootWith,
  CREDENTIALS,
  P,
  writes,
  type Answer,
} from "./distributionFixture.js";

const HASH = "#/p/djdl/distribution/credentials";

resetAround();

/** The fixture's keys plus Sentry's, the one credential that belongs to no channel. */
const SENTRY = {
  ...CREDENTIALS.credentials[0]!,
  id: "sentry-alerts",
  kind: "sentry-integration",
  outletId: null,
  meta: {},
};
const WITH_SENTRY = {
  ...CREDENTIALS,
  credentials: [...CREDENTIALS.credentials, SENTRY],
};

const boot = (hash: string, routes: Record<string, Answer> = {}) =>
  bootWith(hash, { [P("/outlet-credentials")]: WITH_SENTRY, ...routes });

/** A product whose platforms fit Google Play and the direct channel only. */
const NO_APPLE = {
  "/manage/api/products/djdl": {
    product: {
      slug: "djdl",
      name: "DJDL",
      signingKid: "kid-1",
      compatMin: "1.0.0",
      compatMax: "2.0.0",
      defaultMaxOfflineDays: 14,
      defaultDeviceLimit: 3,
      adminGroup: null,
      manifestAuthoritative: { value: false, locked: false },
      createdAt: 0,
      modifiedAt: 0,
      platforms: [
        { platform: "android", arches: [], formats: [], sources: [] },
      ],
      channels: [
        {
          id: "google-play",
          label: "Google Play",
          inScope: true,
          delivery: "live",
          notUsing: false,
        },
      ],
    },
  },
};

async function table(): Promise<HTMLElement> {
  const t = await screen.findByRole("table", { name: "Credentials" });
  await within(t).findByText("sentry-alerts");
  return t;
}

describe("Distribution → Channel credentials", () => {
  it("lists only what no channel page holds, never a value (OUT-1, OUT-6)", async () => {
    boot(HASH);
    const t = await table();
    expect(
      screen.getByRole("heading", { level: 1, name: "Credentials" }),
    ).toBeTruthy();
    expect(within(t).getByText("Sentry internal integration")).toBeTruthy();
    // The App Store and Google keys moved to their channels' Setup tabs.
    expect(within(t).queryByText("asc-team-key")).toBeNull();
    expect(within(t).queryByText("play")).toBeNull();
    expect(within(t).queryByText("Out of scope")).toBeNull();
    expect(screen.queryByText(/BEGIN PRIVATE KEY/)).toBeNull();
  });

  it("links to each in-scope store's Setup tab", async () => {
    boot(HASH);
    await table();
    const links = screen.getByRole("region", { name: "Store keys" });
    expect(
      within(links)
        .getByRole("link", { name: /^App Store/ })
        .getAttribute("href"),
    ).toBe("#/p/djdl/distribution/channels/app-store/setup");
    expect(within(links).getByRole("link", { name: "Steam" })).toBeTruthy();
  });

  it("keeps a held key whose channel is out of scope, flagged (A-20 R6)", async () => {
    boot(HASH, NO_APPLE);
    const t = await table();
    expect(within(t).getByText("asc-team-key")).toBeTruthy();
    expect(within(t).getAllByText("Out of scope")).toHaveLength(1);
    expect(
      within(t).getByText(/Delete the key, or add a platform/),
    ).toBeTruthy();
    // Its channel is out of scope, so there is no Setup link for it; Google Play's is there.
    const links = screen.getByRole("region", { name: "Store keys" });
    expect(
      within(links).queryByRole("link", { name: /^App Store/ }),
    ).toBeNull();
    expect(
      within(links).getByRole("link", { name: /^Google Play/ }),
    ).toBeTruthy();
    // The key is still editable here: delete is offered.
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for asc-team-key" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Delete…" }),
    ).toBeTruthy();
  });

  it("sends an old store-key link to its channel's Setup", async () => {
    boot(`${HASH}?credential=asc-team-key`);
    await waitFor(() =>
      expect(window.location.hash).toBe(
        "#/p/djdl/distribution/channels/app-store/setup?credential=asc-team-key",
      ),
    );
  });

  it("sets Sentry's secret, the only kind offered here (OUT-7)", async () => {
    const { calls } = boot(HASH, {
      [`PUT ${P("/outlet-credentials/sentry-2")}`]: {
        ok: true,
        id: "sentry-2",
      },
    });
    await table();
    const drawer = await openSetDrawer();
    // The only kind here: said, not asked.
    expect(within(drawer).queryByRole("combobox", { name: /Kind/ })).toBeNull();
    expect(
      within(drawer).getByText("Sentry internal integration"),
    ).toBeTruthy();
    await userEvent.type(
      within(drawer).getByLabelText(/Credential ID/),
      "sentry-2",
    );
    await userEvent.type(
      within(drawer).getByLabelText(/Client secret/i),
      "s3cret",
    );
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Set credential" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          body: {
            kind: "sentry-integration",
            value: { clientSecret: "s3cret" },
            outletId: null,
          },
        }),
      ]),
    );
    expect(document.body.textContent).not.toContain("s3cret");
  });

  it("warns that reusing an id rotates it, and confirms first (OUT-2)", async () => {
    const { calls } = boot(HASH, {
      [`PUT ${P("/outlet-credentials/sentry-alerts")}`]: {
        ok: true,
        id: "sentry-alerts",
      },
    });
    await table();
    const drawer = await openSetDrawer();
    await userEvent.type(
      within(drawer).getByLabelText(/Credential ID/),
      "sentry-alerts",
    );
    expect(
      await within(drawer).findByText("A credential with this id exists"),
    ).toBeTruthy();
    await userEvent.type(
      within(drawer).getByLabelText(/Client secret/),
      "s3cret",
    );
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Rotate credential…" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    expect(writes(calls)).toEqual([]);
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Rotate credential" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          body: {
            kind: "sentry-integration",
            value: { clientSecret: "s3cret" },
            outletId: null,
          },
        }),
      ]),
    );
  });

  it("round-trips the kind facet through the URL", async () => {
    boot(`${HASH}?kind=sentry-integration`, NO_APPLE);
    const t = await screen.findByRole("table", { name: "Credentials" });
    await waitFor(() => expect(within(t).getAllByRole("row")).toHaveLength(2));
    expect(within(t).getByText("sentry-alerts")).toBeTruthy();
  });

  it("points to the channels for store controls", async () => {
    boot(HASH);
    await table();
    expect(
      screen.queryByRole("region", { name: "App Store Connect" }),
    ).toBeNull();
    expect(screen.getByRole("link", { name: "Channels" })).toBeTruthy();
  });

  it("explains credentials when there are none, and shows errors with Retry", async () => {
    boot(HASH, {
      [P("/outlet-credentials")]: { ...CREDENTIALS, credentials: [] },
    });
    expect(await screen.findByText("No other credentials yet")).toBeTruthy();
    cleanup();
    resetConsole();
    let fail = true;
    boot(HASH, {
      [P("/outlet-credentials")]: () =>
        fail ? apiError(500, "internal") : WITH_SENTRY,
    });
    const retry = (
      await screen.findAllByRole("button", { name: "Try again" })
    )[0]!;
    fail = false;
    await userEvent.click(retry);
    expect(await table()).toBeTruthy();
  });

  it("is read-only without Ship edit, and carries one action when empty", async () => {
    boot(HASH, { "/manage/api/me": VIEW_ONLY });
    await table();
    expect(
      screen
        .getByRole("button", { name: "Set credential…" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    cleanup();
    resetConsole();
    boot(HASH, {
      [P("/outlet-credentials")]: { ...CREDENTIALS, credentials: [] },
    });
    await screen.findByText("No other credentials yet");
    expect(
      screen.getAllByRole("button", { name: "Set credential…" }),
    ).toHaveLength(1);
  });

  it("tells each store link how many keys it holds and whether one fails", async () => {
    boot(HASH);
    await table();
    const links = screen.getByRole("region", { name: "Store keys" });
    expect(
      within(links).getByRole("link", { name: "App Store · 1 key" }),
    ).toBeTruthy();
    expect(
      within(links).getByRole("link", {
        name: "Google Play · 1 key · 1 failed",
      }),
    ).toBeTruthy();
  });

  it("passes axe", async () => {
    boot(HASH);
    await table();
    await expectNoAxeViolations(document.body);
  });
});
