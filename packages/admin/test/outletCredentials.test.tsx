/**
 * Distribution → Channel credentials (admin chunk 9, ADMIN.md §6.4). Since A-22.3a a store's own
 * keys are edited on its channel's Setup tab (`channelSetup.test.tsx`); this page keeps the
 * credentials that belong to no channel (Sentry), a held key whose channel is out of scope
 * (flagged, A-20 R6), links to each Setup, and the connector cards.
 */

import { describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resetConsole } from "./consoleHarness.js";
import { expectNoAxeViolations } from "./coreTestUtils.js";
import { openSetDrawer, pick, resetAround } from "./credentialsKit.js";
import {
  apiError,
  bootWith,
  CONNECTORS,
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
  const t = await screen.findByRole("table", { name: "Channel credentials" });
  await within(t).findByText("sentry-alerts");
  return t;
}

describe("Distribution → Channel credentials", () => {
  it("lists only what no channel page holds, never a value (OUT-1, OUT-6)", async () => {
    boot(HASH);
    const t = await table();
    expect(
      screen.getByRole("heading", { level: 1, name: "Channel credentials" }),
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
        .getByRole("link", { name: "App Store" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/distribution/channels/app-store/setup");
    expect(within(links).getByRole("link", { name: "Steam" })).toBeTruthy();
  });

  it("keeps a held key whose channel is out of scope, flagged (A-20 R6)", async () => {
    boot(HASH, NO_APPLE);
    const t = await table();
    expect(within(t).getByText("asc-team-key")).toBeTruthy();
    expect(within(t).getAllByText("Out of scope")).toHaveLength(1);
    // Its channel is out of scope, so there is no Setup link for it; Google Play's is there.
    const links = screen.getByRole("region", { name: "Store keys" });
    expect(within(links).queryByRole("link", { name: "App Store" })).toBeNull();
    expect(
      within(links).getByRole("link", { name: "Google Play" }),
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
    await userEvent.click(
      within(drawer).getByRole("combobox", { name: /Kind/ }),
    );
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toMatch(/Sentry internal integration/);
    await userEvent.keyboard("{Escape}");
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
    await pick(drawer, /Kind/, /Sentry internal integration/);
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
    const t = await screen.findByRole("table", { name: "Channel credentials" });
    await waitFor(() => expect(within(t).getAllByRole("row")).toHaveLength(2));
    expect(within(t).getByText("sentry-alerts")).toBeTruthy();
  });

  describe("store connectors", () => {
    it("shows each connector's state, and an inert one's reason", async () => {
      boot(HASH);
      await table();
      const asc = await screen.findByRole("region", {
        name: "App Store Connect",
      });
      expect(within(asc).getByText("Connected")).toBeTruthy();
      const ms = screen.getByRole("region", { name: "Microsoft Store" });
      expect(within(ms).getByText(/Not running/)).toBeTruthy();
      expect(within(ms).getByText(/Declare an ms-store channel/)).toBeTruthy();
    });

    it("says when App Store Connect uses the platform's team key (A-16)", async () => {
      boot(HASH, {
        [P("/distribution/connectors")]: {
          connectors: [
            {
              ...CONNECTORS.connectors[0],
              setup: {
                ...CONNECTORS.connectors[0]!.setup,
                apiKeyCredential: null,
                credentialSource: "platform",
                platformSource: "console",
              },
            },
          ],
        },
      });
      await table();
      const asc = await screen.findByRole("region", {
        name: "App Store Connect",
      });
      expect(
        within(asc).getByText("The platform's team key (set in the console)"),
      ).toBeTruthy();
      expect(within(asc).queryByText("API key credential")).toBeNull();
    });

    /** Open the release dialog and pick 2.4.0. */
    async function openRelease(): Promise<HTMLElement> {
      await table();
      const asc = await screen.findByRole("region", {
        name: "App Store Connect",
      });
      await userEvent.click(
        within(asc).getByRole("button", { name: "Release this version…" }),
      );
      const confirm = await screen.findByRole("alertdialog");
      await userEvent.click(
        within(confirm).getByRole("button", { name: /^Release Required/ }),
      );
      await userEvent.click(
        await screen.findByRole("option", { name: /^2\.4\.0 / }),
      );
      return confirm;
    }

    it("releases a held App Store version at L3, with the app's name typed (A-17a)", async () => {
      const { calls } = boot(HASH, {
        [`POST ${P("/distribution/connectors/asc/release")}`]: { ok: true },
      });
      const confirm = await openRelease();
      // The button is drawn again when its reason goes: read it afresh each time.
      const go = () =>
        within(confirm).getByRole("button", { name: "Release version" });
      // A release is picked, but the name is not typed yet: still disabled.
      expect(go().getAttribute("aria-disabled")).toBe("true");
      await userEvent.click(go());
      expect(writes(calls)).toEqual([]);
      const name = within(confirm).getByRole("textbox", { name: /App name/ });
      await userEvent.type(name, "   ");
      expect(go().getAttribute("aria-disabled")).toBe("true");
      await userEvent.clear(name);
      await userEvent.type(name, " DJDL Mobile ");
      expect(go().getAttribute("aria-disabled")).toBeNull();
      await userEvent.click(go());
      await waitFor(() =>
        expect(writes(calls)).toEqual([
          expect.objectContaining({
            path: P("/distribution/connectors/asc/release"),
            body: { releaseId: "rel_240", confirm: "DJDL Mobile" },
          }),
        ]),
      );
    });

    it("words a name that doesn't match App Store Connect and stays open (A-17a)", async () => {
      boot(HASH, {
        [`POST ${P("/distribution/connectors/asc/release")}`]: () =>
          apiError(
            422,
            "invalid_body",
            { reason: "confirmation_mismatch", fields: ["confirm"] },
            "confirm does not match the app's name in App Store Connect",
          ),
      });
      const confirm = await openRelease();
      await userEvent.type(
        within(confirm).getByRole("textbox", { name: /App name/ }),
        "Wrong name",
      );
      await userEvent.click(
        within(confirm).getByRole("button", { name: "Release version" }),
      );
      expect(
        await within(confirm).findByText(
          /doesn't match the app's name in App Store Connect/,
        ),
      ).toBeTruthy();
    });
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

  it("passes axe", async () => {
    boot(HASH);
    await table();
    await screen.findByRole("region", { name: "App Store Connect" });
    await expectNoAxeViolations(document.body);
  });
});
