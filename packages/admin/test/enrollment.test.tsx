/**
 * License → Enrollment (ADMIN.md §6.5.3) through the whole console: registration read-only with
 * a way to change it (FPP-2), one mode choice (FPP-1), the section's owner and a revert that
 * names both effects (FPP-3), and probes with a resync (FPP-4).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ALL_ON, productRow, resetConsole } from "./consoleHarness.js";
import { API, axe, bootLicense, failing, writes } from "./licenseFixture.js";

beforeEach(resetConsole);
afterEach(cleanup);

const HASH = "#/p/djdl/license/enrollment";
const POLICY = `${API}/license/policy`;
const policy = (
  over: Partial<{ enabled: boolean; defaultMode: string }> = {},
  source = "admin",
  probes = [
    { id: "rekordbox", label: "rekordbox", macos: "/Applications/rekordbox 7" },
    { id: "serato", label: "Serato DJ" },
  ],
) => ({
  policy: { enabled: true, defaultMode: "normal", probes, ...over },
  source,
});

async function section(name: string) {
  await screen.findByRole("heading", { level: 1, name: "Enrollment" });
  return screen.findByRole("region", { name });
}

describe("Enrollment", () => {
  it("shows registration read-only with a way to change it in Services (FPP-2)", async () => {
    bootLicense(HASH, { routes: { [POLICY]: policy() } });
    const reg = await section("Registration");
    expect(await within(reg).findByText("License required")).toBeTruthy();
    expect(within(reg).getByText(/derived from the services/)).toBeTruthy();
    expect(
      within(reg)
        .getByRole("link", { name: "Change in Services" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/services");
    expect(within(reg).queryByRole("radio")).toBeNull();
  });

  it("says a registration lookup failure instead of claiming one", async () => {
    bootLicense(HASH, {
      routes: { [POLICY]: policy(), [`${API}/services`]: failing(500) },
    });
    const reg = await section("Registration");
    expect(
      await within(reg).findByRole("button", { name: /Retry/ }),
    ).toBeTruthy();
  });

  it("is one mode choice, with its owner, and saves both fields without the probes (FPP-1)", async () => {
    const log = bootLicense(HASH, { routes: { [POLICY]: policy() } });
    const fp = await section("Fingerprint policy");
    expect(within(fp).queryByRole("switch")).toBeNull();
    expect(
      within(fp)
        .getByRole("radio", { name: /Normal/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(within(fp).getByText("Set in console")).toBeTruthy();
    // No save bar until something differs.
    expect(screen.queryByRole("button", { name: "Save policy" })).toBeNull();
    await userEvent.click(within(fp).getByRole("radio", { name: /Strict/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() =>
      expect(writes(log)).toEqual([
        {
          path: POLICY,
          method: "PATCH",
          body: { enabled: true, defaultMode: "strict" },
        },
      ]),
    );
  });

  it("maps Off to enforcement off for every tier", async () => {
    const log = bootLicense(HASH, { routes: { [POLICY]: policy() } });
    const fp = await section("Fingerprint policy");
    await userEvent.click(within(fp).getByRole("radio", { name: /^Off/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() =>
      expect(writes(log)[0]!.body).toEqual({
        enabled: false,
        defaultMode: "off",
      }),
    );
  });

  it("reads a disabled policy as Off", async () => {
    bootLicense(HASH, {
      routes: { [POLICY]: policy({ enabled: false, defaultMode: "strict" }) },
    });
    const fp = await section("Fingerprint policy");
    const off = within(fp).getByRole("radio", { name: /^Off/ });
    expect(off.getAttribute("aria-checked")).toBe("true");
  });

  it("returns the policy to the manifest behind a confirm that names auto-issue too (FPP-3)", async () => {
    const log = bootLicense(HASH, { routes: { [POLICY]: policy() } });
    const fp = await section("Fingerprint policy");
    await userEvent.click(
      within(fp).getByRole("button", { name: /Set in console/ }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Revert/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/fingerprint policy goes back/),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/auto-issue policy goes back/),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Return to manifest" }),
    );
    await waitFor(() =>
      expect(writes(log)).toEqual([
        { path: `${POLICY}/revert`, method: "POST" },
      ]),
    );
  });

  it("lists the probes, sortable, and says where they come from (FPP-4)", async () => {
    bootLicense(HASH, { routes: { [POLICY]: policy() } });
    const probes = await section("Probes");
    const t = await within(probes).findByRole("table", { name: "Probes" });
    expect(within(t).getByText("Serato DJ")).toBeTruthy();
    expect(within(t).getByText("/Applications/rekordbox 7")).toBeTruthy();
    expect(within(probes).getByText(".pkey/product")).toBeTruthy();
    await userEvent.click(within(t).getByRole("button", { name: /Probe/ }));
    await waitFor(() => expect(window.location.hash).toContain("sort=label"));
  });

  it("resyncs from the repository behind an L1 confirm, only when linked", async () => {
    const log = bootLicense(HASH, { routes: { [POLICY]: policy() } });
    const probes = await section("Probes");
    // The harness's product has no linked repository.
    const resync = within(probes).getByRole("button", {
      name: /Resync from repo/,
    });
    expect(resync.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(resync);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(writes(log)).toEqual([]);
  });

  it("a linked product resyncs through the shared flow; the result shows above the probes (UX-78)", async () => {
    const log = bootLicense(HASH, {
      routes: {
        [POLICY]: policy(),
        [API]: {
          product: {
            ...productRow("djdl", "DJDL", ALL_ON),
            releaseSource: "github",
          },
        },
        // One path answers both: the dry run reads `plan`, the resync `updated`.
        [`${API}/release/resync`]: {
          ok: true,
          dryRun: true,
          slug: "djdl",
          repository: "acme/djdl",
          commit: "0123456789abcdef",
          plan: {
            apply: [
              {
                area: "fingerprint",
                summary: "Device fingerprint policy from .pkey/product",
              },
            ],
            skipClaimed: [],
            delete: [],
            conflicts: [],
          },
          updated: ["fingerprint"],
        },
      },
    });
    const probes = await section("Probes");
    const resync = within(probes).getByRole("button", {
      name: /Resync from repo/,
    });
    await waitFor(() =>
      expect(resync.getAttribute("aria-disabled")).not.toBe("true"),
    );
    await userEvent.click(resync);
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      await within(dialog).findByRole("button", { name: "Resync from repo" }),
    );
    const panel = await within(probes).findByTestId("resync-result");
    expect(
      within(panel).getByText("Updated: device fingerprint policy."),
    ).toBeTruthy();
    expect(
      log.calls
        .filter((c) => c.path === `${API}/release/resync`)
        .map((c) => c.query),
    ).toEqual(["dryRun=1", ""]);
  });

  it("says plainly when the manifest declares no probes", async () => {
    bootLicense(HASH, { routes: { [POLICY]: policy({}, "manifest", []) } });
    const probes = await section("Probes");
    expect(await within(probes).findByText("No probes declared")).toBeTruthy();
  });

  it("shows the policy load failure with a working retry", async () => {
    const log = bootLicense(HASH, { routes: { [POLICY]: failing(500) } });
    await screen.findByRole("heading", { level: 1, name: "Enrollment" });
    const retry = await screen.findByRole("button", { name: /Retry/ });
    const before = log.calls.filter((c) => c.path === POLICY).length;
    await userEvent.click(retry);
    await waitFor(() =>
      expect(log.calls.filter((c) => c.path === POLICY).length).toBeGreaterThan(
        before,
      ),
    );
  });

  it("passes axe", async () => {
    bootLicense(HASH, { routes: { [POLICY]: policy() } });
    await section("Probes");
    const results = await axe(document.body);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
