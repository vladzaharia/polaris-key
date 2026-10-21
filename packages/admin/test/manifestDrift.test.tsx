import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SettingsDrift, SettingsDriftItem } from "../src/api.js";
import { expectNoAxeViolations, renderAt, resetCore } from "./coreTestUtils.js";

const fns = vi.hoisted(() => ({
  settingsDrift: vi.fn(),
  revertClaim: vi.fn(),
  revertProductSetting: vi.fn(),
}));

vi.mock("../src/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return {
    ...actual,
    api: Object.fromEntries(
      Object.keys(fns).map((k) => [
        k,
        (...a: unknown[]) =>
          (fns as Record<string, (...x: unknown[]) => unknown>)[k]!(...a),
      ]),
    ),
  };
});

const { ManifestDriftSection } =
  await import("../src/console/components/ManifestDriftSection.js");

const item = (over: Partial<SettingsDriftItem>): SettingsDriftItem => ({
  key: "core.name",
  label: "Display name",
  area: "core",
  claimedBy: "u1",
  claimedAt: 1_700_000_100,
  version: 1,
  revert: "claim",
  manifestKnown: true,
  differs: true,
  console: "DJDL Pro",
  manifest: "DJDL",
  ...over,
});

const DRIFT: SettingsDrift = {
  snapshot: {
    origin: "resync",
    appliedAt: 1_700_000_000,
    appliedSha: "abcdef0123",
  },
  items: [
    item({}),
    item({
      key: "license.defaults.deviceLimit",
      label: "Default device limit",
      console: 5,
      manifest: 5,
      differs: false,
    }),
    item({
      key: "licensing.anchorPolicy",
      label: "Anchor policy",
      revert: "setting",
      version: 4,
      console: "owner",
      manifest: "holder",
    }),
    item({
      key: "config.catalog",
      label: "Catalog",
      console: null,
      manifest: null,
      changes: { added: ["run.mode"], removed: [], changed: ["run.max"] },
    }),
  ],
  lastPlan: {
    v: 1,
    origin: "resync",
    commit: "abcdef0123",
    plannedAt: 1_700_000_000,
    plan: {
      apply: [],
      skipClaimed: [],
      delete: [],
      conflicts: [],
      warnings: [
        {
          file: "product",
          path: "/slug",
          code: "deprecated_spelling",
          message: "slug is a deprecated spelling; write product.slug.",
        },
      ],
    },
  },
};

const mount = () =>
  renderAt("#/p/djdl/settings", <ManifestDriftSection slug="djdl" />);

beforeEach(() => {
  resetCore();
  for (const f of Object.values(fns)) f.mockReset();
  fns.settingsDrift.mockResolvedValue(DRIFT);
});
afterEach(cleanup);

describe("Settings → Differs from the manifest (ST-17)", () => {
  it("lists every claimed field with Revert and Keep", async () => {
    mount();
    for (const label of [
      "Display name",
      "Default device limit",
      "Anchor policy",
      "Catalog",
    ]) {
      const row = (await screen.findByRole("heading", { name: label })).closest(
        "li",
      ) as HTMLElement;
      if (label === "Default device limit") {
        // B-058: a row that already matches can only be handed back.
        expect(
          within(row).getByRole("button", {
            name: `Hand ${label} back to the manifest`,
          }).textContent,
        ).toBe("Hand back to manifest");
        expect(
          within(row).queryByRole("button", { name: /^Revert|^Keep/ }),
        ).toBeNull();
        continue;
      }
      expect(
        within(row).getByRole("button", {
          name: `Revert ${label} to the manifest`,
        }),
      ).toBeTruthy();
      expect(
        within(row).getByRole("button", {
          name: `Keep ${label} as set in the console`,
        }),
      ).toBeTruthy();
    }
    const name = screen.getByTestId("drift-core.name");
    expect(within(name).getByText("DJDL Pro")).toBeTruthy();
    expect(within(name).getByText("DJDL")).toBeTruthy();
    expect(within(name).getByText("Differs")).toBeTruthy();
    expect(
      within(
        screen.getByTestId("drift-license.defaults.deviceLimit"),
      ).getByText("Matches"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("drift-config.catalog")).getByText(
        "The manifest adds run.mode; changes run.max",
      ),
    ).toBeTruthy();
    expect(screen.getByText("3 of 4 differ")).toBeTruthy();
  });

  it("a claim this console doesn't know shows no Revert and does not crash (UX review M11)", async () => {
    fns.settingsDrift.mockResolvedValue({
      ...DRIFT,
      items: [item({ key: "core.futureClaim", label: "Future claim" })],
    });
    mount();
    const row = (
      await screen.findByRole("heading", { name: "Future claim" })
    ).closest("li") as HTMLElement;
    expect(within(row).queryByRole("button", { name: /^Revert/ })).toBeNull();
    expect(within(row).getByText("Revert in a newer console")).toBeTruthy();
  });

  it("Revert asks, then calls the claim route and refreshes the view", async () => {
    const user = userEvent.setup();
    fns.revertClaim.mockResolvedValue({ ok: true, applied: true });
    mount();
    await user.click(
      await screen.findByRole("button", {
        name: "Revert Display name to the manifest",
      }),
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: /Return display name to the manifest\?/,
    });
    expect(fns.revertClaim).not.toHaveBeenCalled();
    // B-058: the dialog names both values.
    expect(
      within(dialog).getByText("Console: DJDL Pro → Manifest: DJDL"),
    ).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", { name: "Revert to manifest" }),
    );
    await waitFor(() =>
      expect(fns.revertClaim).toHaveBeenCalledWith("djdl", "core.name"),
    );
    await waitFor(() =>
      expect(fns.settingsDrift.mock.calls.length).toBeGreaterThan(1),
    );
  });

  it("Revert of a row-backed setting sends the version it was read at", async () => {
    const user = userEvent.setup();
    fns.revertProductSetting.mockResolvedValue({ ok: true, applied: true });
    mount();
    await user.click(
      await screen.findByRole("button", {
        name: "Revert Anchor policy to the manifest",
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Revert to manifest" }),
    );
    await waitFor(() =>
      expect(fns.revertProductSetting).toHaveBeenCalledWith(
        "djdl",
        "licensing.anchorPolicy",
        { expectedVersion: 4 },
      ),
    );
  });

  it("Keep calls nothing and marks the row", async () => {
    const user = userEvent.setup();
    mount();
    const keep = await screen.findByRole("button", {
      name: "Keep Display name as set in the console",
    });
    await user.click(keep);
    expect(keep.getAttribute("aria-pressed")).toBe("true");
    expect(
      within(screen.getByTestId("drift-core.name")).getByText("Kept"),
    ).toBeTruthy();
    expect(fns.revertClaim).not.toHaveBeenCalled();
    expect(fns.revertProductSetting).not.toHaveBeenCalled();
  });

  it("lists the last apply's warnings", async () => {
    mount();
    expect(await screen.findByText("1 warning in the last apply")).toBeTruthy();
    expect(
      screen.getByText("slug is a deprecated spelling; write product.slug."),
    ).toBeTruthy();
  });

  it("says so when nothing is claimed", async () => {
    fns.settingsDrift.mockResolvedValue({
      snapshot: null,
      items: [],
      lastPlan: null,
    });
    mount();
    expect(
      await screen.findByText(
        "Nothing is set in the console. Every value follows .pkey/.",
      ),
    ).toBeTruthy();
  });

  it("shows an error state with Retry", async () => {
    const user = userEvent.setup();
    fns.settingsDrift.mockRejectedValueOnce(new Error("boom"));
    mount();
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Display name")).toBeTruthy();
  });

  it("passes axe, with a confirm open too", async () => {
    const user = userEvent.setup();
    const { container } = mount();
    await screen.findByText("Display name");
    await expectNoAxeViolations(container);
    await user.click(
      screen.getByRole("button", {
        name: "Revert Display name to the manifest",
      }),
    );
    await screen.findByRole("alertdialog");
    await expectNoAxeViolations(document.body);
  });
});
