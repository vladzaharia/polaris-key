/**
 * U-27: the license record's Config tab. The licence layer is always read, so the tab has no
 * phase, no banner about a move and no locked editor: every key is editable on every license. The
 * owner's account overrides sit above, and the tab says so (owned) or offers the sign-up link
 * (unowned).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LicenseConfigOverrides } from "../src/api.js";
import { resetConsole } from "./consoleHarness.js";
import { API, DETAIL, bootLicense, writes } from "./licenseFixture.js";
import { configOverridesOf } from "../src/console/sections/license/pages/LicenseConfig.js";

const REC = "#/p/djdl/license/licenses/lic_1/config";
const LIC = `${API}/license/licenses/lic_1`;
const OWNER = "ps_OOOOOOOOOOOOOOOOOOOOOO";
const SIGN_UP = "https://keys.example.com/activate?product=djdl";

function boot(co: LicenseConfigOverrides | undefined) {
  return bootLicense(REC, {
    routes: {
      [LIC]: { ...DETAIL, configOverrides: co },
      [`PUT ${LIC}/overrides`]: { ok: true, id: "lic_1" },
    },
  });
}

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("license record: Config tab", () => {
  it("reads a license with no configOverrides (an older Worker) as unowned", () => {
    expect(configOverridesOf(DETAIL)).toEqual({
      owned: false,
      ownerSubject: null,
      signUpUrl: null,
    });
  });

  it("owned: every key is editable, the owner note links the owner's record", async () => {
    const log = boot({ owned: true, ownerSubject: OWNER, signUpUrl: null });
    expect(await screen.findByText("feature.timeout")).toBeTruthy();
    expect(screen.getByText("api.token")).toBeTruthy();
    expect(screen.getByText("flag.pro")).toBeTruthy();
    expect(screen.getByText("Account overrides win over these")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Open the owner's record" })
        .getAttribute("href"),
    ).toBe(`#/p/djdl/users/${OWNER}`);
    // Nothing about a migration, a move or a freeze.
    expect(screen.queryByText(/migrat|moved|moving|dropped/i)).toBeNull();
    expect(screen.queryByText("Save entitlements")).toBeNull();
    // A config key and an entitlement save in one batch.
    const radios = screen.getAllByRole("radio", { name: /Read-only/ });
    await userEvent.click(radios[0]!);
    await userEvent.click(
      await screen.findByRole("button", { name: /Save overrides/ }),
    );
    await waitFor(() => expect(writes(log)).toHaveLength(1));
  });

  it("unowned: every key is editable, with the sign-up link to offer", async () => {
    boot({ owned: false, ownerSubject: null, signUpUrl: SIGN_UP });
    expect(await screen.findByText("feature.timeout")).toBeTruthy();
    expect(screen.getByText("api.token")).toBeTruthy();
    expect(screen.getByText("flag.pro")).toBeTruthy();
    expect(
      screen.getByText(
        "No account: managed config for this customer needs an account",
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
    expect(screen.queryByText(/migrat|moved|moving|dropped/i)).toBeNull();
  });
});
