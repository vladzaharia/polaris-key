/**
 * U-03: the license record's Config tab through the account override migration. Before the
 * notice nothing changes; during it the tab says where the license's config and secret
 * overrides go (the owner's account overrides, or dropped with the portal link to offer the
 * customer); from the run's start it edits entitlements only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LicenseConfigOverrides, ProductCatalog } from "../src/api.js";
import { resetConsole } from "./consoleHarness.js";
import {
  API,
  CATALOG,
  DETAIL,
  NOW_S,
  bootLicense,
  writes,
} from "./licenseFixture.js";
import {
  configOverridesOf,
  entitlementsOnly,
  licenseEditorCatalog,
} from "../src/console/pages/license/LicenseConfig.js";
import { upcomingRunDate } from "../src/console/data/overrideMigration.js";
import { formatDate, fromSeconds } from "../src/lib/format.js";

const REC = "#/p/djdl/license/licenses/lic_1/config";
const LIC = `${API}/license/licenses/lic_1`;
const OWNER = "ps_OOOOOOOOOOOOOOOOOOOOOO";
const RUN_AT = NOW_S + 20 * 86_400;
const SIGN_UP = "https://keys.example.com/activate?product=djdl";

function phase(over: Partial<LicenseConfigOverrides>): LicenseConfigOverrides {
  return {
    phase: "license",
    owned: true,
    ownerSubject: OWNER,
    runNotBefore: null,
    signUpUrl: null,
    ...over,
  };
}

function bootPhase(
  co: LicenseConfigOverrides,
  routes: Record<string, unknown> = {},
) {
  const moved = co.phase === "moved";
  return bootLicense(REC, {
    routes: {
      [LIC]: {
        ...DETAIL,
        // The Worker stops sending a moved licence's config and secrets (step 5).
        overrides: moved
          ? { ...DETAIL.overrides, config: {}, secrets: {} }
          : DETAIL.overrides,
        configOverrides: co,
      },
      [`PUT ${LIC}/overrides`]: { ok: true, id: "lic_1" },
      ...routes,
    },
  });
}

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the phase model", () => {
  it("reads a license with no configOverrides (an older Worker) as phase license", () => {
    expect(configOverridesOf(DETAIL).phase).toBe("license");
    expect(entitlementsOnly(configOverridesOf(DETAIL))).toBe(false);
  });

  it("edits entitlements only from the run's start", () => {
    expect(entitlementsOnly(phase({ phase: "license" }))).toBe(false);
    expect(entitlementsOnly(phase({ phase: "notice" }))).toBe(false);
    expect(entitlementsOnly(phase({ phase: "moving" }))).toBe(true);
    expect(entitlementsOnly(phase({ phase: "moved" }))).toBe(true);
    expect(
      licenseEditorCatalog(CATALOG, true).entries.map((e) => e.key),
    ).toEqual(["flag.pro"]);
    expect(licenseEditorCatalog(CATALOG, false)).toBe(CATALOG);
  });

  it("names the run date only while it is ahead", () => {
    const now = fromSeconds(NOW_S);
    expect(upcomingRunDate(RUN_AT, now)).toBe(formatDate(fromSeconds(RUN_AT)));
    expect(upcomingRunDate(NOW_S - 60, now)).toBeNull();
    expect(upcomingRunDate(null, now)).toBeNull();
  });
});

describe("license record: Config tab across the migration", () => {
  it("before the notice: every key, and nothing about the move", async () => {
    bootPhase(phase({ phase: "license" }));
    expect(await screen.findByText("feature.timeout")).toBeTruthy();
    expect(screen.getByText("flag.pro")).toBeTruthy();
    expect(screen.queryByText(/account overrides/)).toBeNull();
  });

  it("notice, owned: the run date, the owner's record, and the editor unchanged", async () => {
    bootPhase(phase({ phase: "notice", runNotBefore: RUN_AT }));
    expect(
      await screen.findByText("Config and secrets move to account overrides"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        new RegExp(
          `On ${formatDate(fromSeconds(RUN_AT))}, this license's config and secret overrides move to its owner's account overrides`,
        ),
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Open the owner's record" })
        .getAttribute("href"),
    ).toBe(`#/p/djdl/users/${OWNER}`);
    expect(await screen.findByText("feature.timeout")).toBeTruthy();
    expect(screen.getByText("api.token")).toBeTruthy();
    expect(screen.getByText("flag.pro")).toBeTruthy();
  });

  it("notice, unowned: dropped on the date, with the sign-up link to offer", async () => {
    bootPhase(
      phase({
        phase: "notice",
        owned: false,
        ownerSubject: null,
        runNotBefore: RUN_AT,
        signUpUrl: SIGN_UP,
      }),
    );
    expect(
      await screen.findByText(
        "No account: managed config for this customer needs an account",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        new RegExp(
          `On ${formatDate(fromSeconds(RUN_AT))}, these config and secret overrides are dropped`,
        ),
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: SIGN_UP }).getAttribute("href"),
    ).toBe(SIGN_UP);
    expect(
      screen.getByRole("button", { name: "Copy the sign-up link" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "Open the owner's record" }),
    ).toBeNull();
    // Still editable until the run.
    expect(await screen.findByText("feature.timeout")).toBeTruthy();
  });

  it("moved, owned: entitlements only, and config and secrets point at the owner", async () => {
    const log = bootPhase(phase({ phase: "moved" }));
    expect(
      await screen.findByText("Config and secrets moved to account overrides"),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Open the owner's record" })
        .getAttribute("href"),
    ).toBe(`#/p/djdl/users/${OWNER}`);
    expect(await screen.findByText("flag.pro")).toBeTruthy();
    expect(screen.queryByText("feature.timeout")).toBeNull();
    expect(screen.queryByText("api.token")).toBeNull();
    // Edit the entitlement: the batch carries the flag alone.
    const radios = screen.getAllByRole("radio", { name: /Enforced/ });
    await userEvent.click(radios[0]!);
    await userEvent.click(
      await screen.findByRole("button", { name: /Save entitlements/ }),
    );
    await waitFor(() => expect(writes(log)).toHaveLength(1));
    const body = writes(log)[0]!.body as { updates: { key: string }[] };
    expect(body.updates.map((u) => u.key)).toEqual(["flag.pro"]);
  });

  it("moving, unowned: says the overrides are dropped and offers the sign-up link", async () => {
    bootPhase(
      phase({
        phase: "moving",
        owned: false,
        ownerSubject: null,
        signUpUrl: SIGN_UP,
      }),
    );
    const title = await screen.findByText(
      "No account: managed config for this customer needs an account",
    );
    const callout = title.closest("[data-tone]") as HTMLElement;
    expect(within(callout).getByText(/The migration is running/)).toBeTruthy();
    expect(within(callout).getByRole("link", { name: SIGN_UP })).toBeTruthy();
    expect(await screen.findByText("flag.pro")).toBeTruthy();
    expect(screen.queryByText("feature.timeout")).toBeNull();
  });

  it("moved with no entitlements in the catalog: nothing of its own to set", async () => {
    const noFlags: ProductCatalog = {
      schemaVersion: 4,
      entries: CATALOG.entries.filter((e) => e.kind !== "flag"),
    };
    bootPhase(phase({ phase: "moved" }), {
      [`${API}/config/catalog`]: noFlags,
    });
    expect(await screen.findByText("No entitlements to override")).toBeTruthy();
    expect(screen.queryByText("feature.timeout")).toBeNull();
  });
});
