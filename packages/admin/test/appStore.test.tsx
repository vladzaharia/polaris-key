/**
 * Distribution → App Store (the Distribute flow) and Distribution → Commerce (App Store products),
 * A-17g; notes/S-14 §8.2, §8.3. The flow's steps follow the URL and Apple's answers; every write is
 * the named Worker control with one `Idempotency-Key` per intent; submit, release, completing a
 * phased release and price or availability changes are typed with the app's name.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { resetConsole } from "./consoleHarness.js";
import {
  ASC_BUILDS,
  ASC_IAP_PRODUCTS,
  CONNECTORS,
  P,
  apiError,
  bootWith,
  writes,
} from "./distributionFixture.js";

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});

const APP = "#/p/djdl/distribution/app-store";
const COMMERCE = "#/p/djdl/distribution/commerce";
const ASC = (path: string) => P(`/distribution/connectors/asc/${path}`);

beforeEach(() => resetConsole());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The fixture's builds with b-52's export compliance already answered. */
const ANSWERED = {
  ...ASC_BUILDS,
  builds: ASC_BUILDS.builds.map((b) =>
    b.id === "b-52"
      ? { ...b, usesNonExemptEncryption: false, exportComplianceNeeded: false }
      : b,
  ),
};

const violations = (r: {
  violations: { id: string; nodes: { target: unknown[] }[] }[];
}) =>
  r.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );

async function confirmIn(dialog: HTMLElement, name: string): Promise<void> {
  await userEvent.click(within(dialog).getByRole("button", { name }));
}

describe("Distribution → App Store: the Distribute flow", () => {
  it("lists builds newest first; a processing build can't be chosen", async () => {
    bootWith(APP);
    const group = await screen.findByRole("radiogroup", { name: "Builds" });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios[0]!.textContent).toContain("2.4.1 (53)");
    expect(radios[0]!.hasAttribute("disabled")).toBe(true);
    expect(within(group).getByText(/ITMS-90725/)).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 1, name: "App Store" }),
    ).toBeTruthy();
    // Continue waits for a build.
    expect(
      screen
        .getByRole("button", { name: "Continue" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("answers export compliance with the build's control and an Idempotency-Key", async () => {
    const { calls } = bootWith(`${APP}?build=b-52&step=compliance`);
    await screen.findByRole("heading", { name: "Export compliance" });
    await userEvent.click(
      screen.getByRole("radio", { name: /^Doesn't use non-exempt encryption/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save answer…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/can't be changed/)).toBeTruthy();
    await confirmIn(dialog, "Save answer");
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: ASC("distribute/export-compliance"),
          method: "POST",
          body: { buildId: "b-52", usesNonExemptEncryption: false },
          idempotencyKey: expect.stringMatching(/^[A-Za-z0-9-]{8,128}$/),
        }),
      ]),
    );
  });

  it("an earlier incomplete step wins over the asked one", async () => {
    bootWith(`${APP}?build=b-52&step=submit`);
    await screen.findByRole("heading", { name: "Export compliance" });
    expect(window.location.hash).toContain("step=compliance");
  });

  it("saves release notes to TestFlight, one call per locale under one key", async () => {
    const { calls } = bootWith(`${APP}?build=b-52&step=notes`, {
      [ASC("distribute/builds")]: ANSWERED,
    });
    await screen.findByRole("heading", { name: "Release notes" });
    await userEvent.type(
      screen.getByRole("textbox", { name: /What's New/ }),
      "Faster sync.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Add locale" }));
    const locales = screen.getAllByRole("textbox", { name: /Locale/ });
    await userEvent.type(locales[1]!, "de-DE");
    await userEvent.type(
      screen.getAllByRole("textbox", { name: /What's New/ })[1]!,
      "Schneller.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save to TestFlight…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await confirmIn(dialog, "Save to TestFlight");
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    const [a, b] = writes(calls);
    expect(a).toMatchObject({
      path: ASC("distribute/beta-localization"),
      body: { buildId: "b-52", locale: "en-US", whatsNew: "Faster sync." },
    });
    expect(b).toMatchObject({
      body: { buildId: "b-52", locale: "de-DE", whatsNew: "Schneller." },
    });
    expect(a!.idempotencyKey).toBeTruthy();
    expect(b!.idempotencyKey).toBe(a!.idempotencyKey);
  });

  it("adds the build to the ticked TestFlight groups", async () => {
    const { calls } = bootWith(`${APP}?build=b-52&step=testflight`, {
      [ASC("distribute/builds")]: ANSWERED,
    });
    await screen.findByRole("heading", { name: "TestFlight" });
    await userEvent.click(
      await screen.findByRole("checkbox", { name: /Studio team/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Add to groups…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await confirmIn(dialog, "Add to groups");
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: ASC("distribute/testflight/groups"),
          body: { buildId: "b-52", betaGroupIds: ["g-int"] },
        }),
      ]),
    );
  });

  it("creates the version and keeps its id in the URL", async () => {
    const { calls } = bootWith(`${APP}?build=b-52&step=version`, {
      [ASC("distribute/builds")]: ANSWERED,
      [`POST ${ASC("distribute/version")}`]: {
        ok: true,
        outcome: "existing",
        versionId: "v-240",
        platform: "IOS",
        versionString: "2.4.0",
      },
    });
    await screen.findByRole("heading", { name: "App Store version" });
    expect(screen.getByText(/will be reused/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Use version…" }));
    const dialog = await screen.findByRole("alertdialog");
    await confirmIn(dialog, "Use version");
    await waitFor(() =>
      expect(window.location.hash).toContain("version=v-240"),
    );
    expect(writes(calls)[0]).toMatchObject({
      path: ASC("distribute/version"),
      body: { platform: "IOS", versionString: "2.4.0" },
    });
    await screen.findByRole("heading", { name: "App Store version 2.4.0" });
    expect(screen.getByText("Attached")).toBeTruthy();
  });

  it("sets a scheduled release and a phased release on the version", async () => {
    const { calls } = bootWith(`${APP}?build=b-52&version=v-240&step=version`, {
      [ASC("distribute/builds")]: ANSWERED,
    });
    await screen.findByRole("heading", { name: "App Store version 2.4.0" });
    await userEvent.click(
      screen.getByRole("button", { name: "Use a phased release…" }),
    );
    let dialog = await screen.findByRole("alertdialog");
    await confirmIn(dialog, "Use phased release");
    await waitFor(() =>
      expect(writes(calls)[0]).toMatchObject({
        path: ASC("distribute/version/phased-release"),
        body: { versionId: "v-240" },
      }),
    );
    await userEvent.click(screen.getByRole("radio", { name: /^Manually/ }));
    await userEvent.click(
      screen.getByRole("button", { name: "Save release option…" }),
    );
    dialog = await screen.findByRole("alertdialog");
    await confirmIn(dialog, "Save release option");
    await waitFor(() =>
      expect(writes(calls)[1]).toMatchObject({
        path: ASC("distribute/version/release-type"),
        body: { versionId: "v-240", releaseType: "MANUAL" },
      }),
    );
    // Each intent has its own key.
    expect(writes(calls)[1]!.idempotencyKey).not.toBe(
      writes(calls)[0]!.idempotencyKey,
    );
  });

  it("shows the preflight with portal-only items and deep links", async () => {
    bootWith(`${APP}?build=b-52&version=v-240&step=preflight`, {
      [ASC("distribute/builds")]: ANSWERED,
    });
    await screen.findByText("Fix the missing items before submitting");
    expect(screen.getByText("Missing: de-DE")).toBeTruthy();
    expect(screen.getByText("Check in App Store Connect")).toBeTruthy();
    expect(screen.getByText("External testing only")).toBeTruthy();
    const links = screen.getAllByRole("link", {
      name: /Open in App Store Connect/,
    });
    expect(links[0]!.getAttribute("href")).toBe(
      "https://appstoreconnect.apple.com/apps/1234567890/distribution",
    );
    expect(links[0]!.getAttribute("target")).toBe("_blank");
  });

  it("submits for review only with the typed app name, with the ready IAP", async () => {
    const { calls } = bootWith(`${APP}?build=b-52&version=v-240&step=submit`, {
      [ASC("distribute/builds")]: ANSWERED,
    });
    await screen.findByRole("heading", { name: "Submit for review" });
    expect(
      await screen.findByRole("checkbox", { name: /In-App Purchase DJDL Pro/ }),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Submit for review…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", {
      name: "Submit for review",
    });
    expect(
      confirm.hasAttribute("disabled") ||
        confirm.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    await userEvent.type(within(dialog).getByLabelText(/App name/), "DJDL");
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: ASC("distribute/submit"),
          body: {
            versionId: "v-240",
            inAppPurchaseVersionIds: ["iv-1"],
            confirm: "DJDL",
          },
        }),
      ]),
    );
  });

  it("keeps the key on a retry after a refusal, and words the refusal", async () => {
    let n = 0;
    const { calls } = bootWith(`${APP}?build=b-52&version=v-240&step=submit`, {
      [ASC("distribute/builds")]: ANSWERED,
      [`POST ${ASC("distribute/submit")}`]: () =>
        n++ === 0
          ? apiError(422, "bad_request", {
              reason: "confirmation_mismatch",
              fields: ["confirm"],
            })
          : { ok: true, versionId: "v-240", state: "WAITING_FOR_REVIEW" },
    });
    await screen.findByRole("heading", { name: "Submit for review" });
    await userEvent.click(
      screen.getByRole("button", { name: "Submit for review…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.type(within(dialog).getByLabelText(/App name/), "DJDl");
    await confirmIn(dialog, "Submit for review");
    expect(
      await within(dialog).findByText(/doesn't match the app's name/),
    ).toBeTruthy();
    await userEvent.clear(within(dialog).getByLabelText(/App name/));
    await userEvent.type(within(dialog).getByLabelText(/App name/), "DJDL");
    await confirmIn(dialog, "Submit for review");
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)[1]!.idempotencyKey).toBe(
      writes(calls)[0]!.idempotencyKey,
    );
  });

  it("releases a phased release to everyone only when typed, by its linked release", async () => {
    const { calls } = bootWith(APP);
    const versions = await screen.findByRole("list", { name: "Versions" });
    await userEvent.click(
      await within(versions).findByRole("button", {
        name: "Release to everyone…",
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.type(within(dialog).getByLabelText(/App name/), "DJDL");
    await confirmIn(dialog, "Release 2.3.9");
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: ASC("phased-release/complete"),
          body: { releaseId: "rel_239", confirm: "DJDL" },
        }),
      ]),
    );
  });

  it("cancels a review submission with a plain confirm", async () => {
    const { calls } = bootWith(APP);
    const subs = await screen.findByRole("list", {
      name: "Review submissions",
    });
    await userEvent.click(
      within(subs).getByRole("button", { name: "Cancel submission…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).queryByLabelText(/App name/)).toBeNull();
    await confirmIn(dialog, "Cancel submission");
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: ASC("distribute/submission/cancel"),
          body: { submissionId: "s-1" },
        }),
      ]),
    );
  });

  it("is read-only with the reason when the connector can't run", async () => {
    bootWith(APP, {
      [P("/distribution/connectors")]: {
        connectors: [
          {
            ...CONNECTORS.connectors[0],
            configured: false,
            inert: {
              reason: "credential_pin_missing",
              message: "the App Store Connect key has no pin",
            },
          },
        ],
      },
    });
    expect(
      await screen.findByText("The App Store Connect key has no pin"),
    ).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "Builds" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Open Outlet credentials" }),
    ).toBeTruthy();
  });

  it("passes axe", async () => {
    bootWith(APP);
    await screen.findByRole("radiogroup", { name: "Builds" });
    await screen.findByRole("list", { name: "Versions" });
    expect(violations(await axe(document.body))).toEqual([]);
  });
});

describe("Distribution → Commerce: App Store products", () => {
  async function table(): Promise<HTMLElement> {
    const t = await screen.findByRole("table", { name: "App Store products" });
    await within(t).findByText("gg.acme.djdl.pro");
    return t;
  }

  it("lists each mapping beside Apple's state", async () => {
    bootWith(COMMERCE);
    const t = await table();
    expect(within(t).getByText("Ready to submit")).toBeTruthy();
    expect(within(t).getByText("Not created")).toBeTruthy();
    expect(within(t).getByText("pro-content")).toBeTruthy();
  });

  it("creates a missing In-App Purchase with its localization", async () => {
    const { calls } = bootWith(COMMERCE);
    await table();
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for gg.acme.djdl.stems" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Create in App Store…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /Display name/ }),
      "Stems pack",
    );
    await confirmIn(dialog, "Create In-App Purchase");
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: ASC("iap/create"),
          body: {
            productId: "gg.acme.djdl.stems",
            referenceName: "gg.acme.djdl.stems",
            familySharable: false,
            localizations: [{ locale: "en-US", name: "Stems pack" }],
          },
          idempotencyKey: expect.any(String),
        }),
      ]),
    );
  });

  it("changing an existing price is typed and carries Apple's warning", async () => {
    const { calls } = bootWith(COMMERCE);
    await table();
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for gg.acme.djdl.pro" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Set price…" }),
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: /Change the price/,
    });
    expect(within(dialog).getByText(/can't be reverted/)).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("combobox", { name: /Price/ }),
    );
    await userEvent.click(await screen.findByRole("option", { name: /9\.99/ }));
    await userEvent.type(within(dialog).getByLabelText(/App name/), "DJDL");
    await confirmIn(dialog, "Change price");
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: ASC("iap/price"),
          body: {
            productId: "gg.acme.djdl.pro",
            baseTerritory: "USA",
            pricePointId: "pp-999",
            confirm: "DJDL",
          },
        }),
      ]),
    );
  });

  it("every availability write is typed", async () => {
    const { calls } = bootWith(COMMERCE);
    await table();
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for gg.acme.djdl.pro" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", {
        name: "Make available everywhere…",
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.type(within(dialog).getByLabelText(/App name/), "DJDL");
    await confirmIn(dialog, "Make available");
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: ASC("iap/availability"),
          body: { productId: "gg.acme.djdl.pro", confirm: "DJDL" },
        }),
      ]),
    );
  });

  it("says the first In-App Purchase goes through App Store Connect", async () => {
    bootWith(COMMERCE, {
      [ASC("iap/products")]: {
        ...ASC_IAP_PRODUCTS,
        firstInAppPurchase: true,
        firstInAppPurchaseNote:
          "Submit your first In-App Purchase with your next app version in App Store Connect.",
      },
    });
    await table();
    expect(
      screen.getByText(
        /Submit your first In-App Purchase with your next app version/,
      ),
    ).toBeTruthy();
  });

  it("passes axe", async () => {
    bootWith(COMMERCE);
    await table();
    expect(violations(await axe(document.body))).toEqual([]);
  });
});
