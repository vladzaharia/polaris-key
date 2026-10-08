import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProductDetail } from "../src/api.js";
import { expectNoAxeViolations, renderAt, resetCore } from "./coreTestUtils.js";

const fns = vi.hoisted(() => ({
  product: vi.fn(),
  updateProduct: vi.fn(),
  deleteProduct: vi.fn(),
  resyncProduct: vi.fn(),
  planResync: vi.fn(),
  revertClaim: vi.fn(),
  checkRepoLink: vi.fn(),
  linkProductRepo: vi.fn(),
  blobGc: vi.fn(),
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

const { ApiError } = await import("../src/api.js");
const { SettingsPage } = await import("../src/console/pages/core/Settings.js");

function product(over: Partial<ProductDetail> = {}): ProductDetail {
  return {
    slug: "djdl",
    name: "DJDL",
    signingKid: "k",
    releaseSource: "github",
    compatMin: "1.0.0",
    compatMax: "2.0.0",
    defaultMaxOfflineDays: 30,
    defaultDeviceLimit: 5,
    adminGroup: "djdl-admins",
    createdAt: 1_700_000_000,
    modifiedAt: 1_700_000_100,
    services: {
      license: { enabled: true },
      config: { enabled: true },
      release: { enabled: true },
      distribution: { enabled: false },
      update: { enabled: true },
      identity: { enabled: false },
      sync: { enabled: false },
    },
    setup: { sync: { status: "ok", lastSyncedAt: 1_700_000_000 } },
    ...over,
  };
}

const mount = () => renderAt("#/p/djdl/settings", <SettingsPage slug="djdl" />);

beforeEach(() => {
  resetCore();
  for (const f of Object.values(fns)) f.mockReset();
  fns.product.mockResolvedValue({ product: product() });
  fns.blobGc.mockResolvedValue({
    enabled: true,
    graceSeconds: 604800,
    lockAgeSeconds: 3600,
    drops: { packObject: 12, packUpload: 3, truncated: false, listed: [] },
    restores: { count: 0, listed: [] },
    earliestDeletion: null,
  });
});
afterEach(cleanup);

describe("Core → Settings", () => {
  it("saves only what changed (A-3, PRD-6)", async () => {
    const user = userEvent.setup();
    fns.updateProduct.mockResolvedValue({ ok: true, slug: "djdl" });
    // A manual product: no manifest to claim from, so a save is sent as is.
    fns.product.mockResolvedValue({
      product: product({ releaseSource: "manual" }),
    });
    mount();
    const name = await screen.findByLabelText(/Display name/);
    await user.clear(name);
    await user.type(name, "DJDL Pro");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(fns.updateProduct).toHaveBeenCalledWith("djdl", {
        name: "DJDL Pro",
      }),
    );
    // The product refetches (the mutation table).
    await waitFor(() =>
      expect(fns.product.mock.calls.length).toBeGreaterThan(1),
    );
  });

  it("refuses a blank display name instead of dropping it", async () => {
    const user = userEvent.setup();
    mount();
    const name = await screen.findByLabelText(/Display name/);
    await user.clear(name);
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Enter a display name.")).toBeTruthy();
    expect(fns.updateProduct).not.toHaveBeenCalled();
  });

  it("validates license defaults as the server does", async () => {
    const user = userEvent.setup();
    mount();
    const days = await screen.findByLabelText(/Default max offline days/);
    await user.clear(days);
    await user.type(days, "400");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText(/from 1 to 365/)).toBeTruthy();
    expect(fns.updateProduct).not.toHaveBeenCalled();
  });

  it("hides license defaults when License is off, and links the compatibility window to Update → Feed (SET-3)", async () => {
    mount();
    const link = await screen.findByRole("link", {
      name: /Open Update → Feed/,
    });
    expect(link.getAttribute("href")).toBe("#/p/djdl/update/feed");
    cleanup();
    resetCore();
    fns.product.mockResolvedValue({
      product: product({
        services: { ...product().services!, license: { enabled: false } },
      }),
    });
    mount();
    await screen.findByRole("heading", { name: "Repository" });
    expect(
      screen.queryByRole("heading", { name: "License defaults" }),
    ).toBeNull();
  });

  const RESYNC_PLAN = {
    ok: true,
    dryRun: true,
    slug: "djdl",
    repository: "acme/djdl",
    commit: "abcdef0123456789",
    plan: {
      apply: [{ area: "tiers", id: "studio", summary: "Tier studio added" }],
      skipClaimed: [
        {
          area: "services",
          summary:
            "Services stay as set in the console (the manifest turns on release)",
        },
      ],
      delete: [{ area: "tiers", id: "legacy", summary: "Tier legacy" }],
      conflicts: [] as { area: string; id?: string; summary: string }[],
    },
  };

  it("resyncs after an L1 confirm that shows the plan, then focuses what it did (RSY-3, UX-78)", async () => {
    const user = userEvent.setup();
    fns.planResync.mockResolvedValue(RESYNC_PLAN);
    fns.resyncProduct.mockResolvedValue({
      ok: true,
      slug: "djdl",
      updated: ["services", "schema"],
      refused: [
        {
          code: "release_key_is_product_key",
          path: "release.keys",
          message: "kept the previous keys",
        },
      ],
      packSets: { ok: true, sets: 2 },
    });
    mount();
    await user.click(
      await screen.findByRole("button", { name: "Resync from repo…" }),
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: /Resync DJDL from its repository\?/,
    });
    expect(fns.planResync).toHaveBeenCalledWith("djdl");
    expect(await within(dialog).findByText("Tier studio added")).toBeTruthy();
    expect(within(dialog).getByText("Stays (set in the console)")).toBeTruthy();
    expect(within(dialog).getByText("Tier legacy")).toBeTruthy();
    expect(within(dialog).getByText("acme/djdl")).toBeTruthy();
    expect(within(dialog).getByText("abcdef0")).toBeTruthy();
    expect(fns.resyncProduct).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("button", { name: "Resync from repo" }),
    );
    const panel = await screen.findByTestId("resync-result");
    expect(
      within(panel).getByText("Resynced DJDL, with 1 part refused"),
    ).toBeTruthy();
    expect(within(panel).getByText("Updated: services, catalog.")).toBeTruthy();
    expect(within(panel).getByText(/kept the previous keys/)).toBeTruthy();
    expect(within(panel).getByText("Pack sets resolved: 2.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(panel));
  });

  it("a plan with conflicts keeps Resync disabled and says how to fix it", async () => {
    const user = userEvent.setup();
    fns.planResync.mockResolvedValue({
      ...RESYNC_PLAN,
      plan: {
        ...RESYNC_PLAN.plan,
        conflicts: [
          {
            area: "tiers",
            id: "pro",
            summary:
              "Tier pro is not in the manifest but 3 licenses use it: add it to .pkey/product or move them first",
          },
        ],
      },
    });
    mount();
    await user.click(
      await screen.findByRole("button", { name: "Resync from repo…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(await within(dialog).findByText("Blocks the resync")).toBeTruthy();
    expect(
      within(dialog)
        .getByRole("button", { name: "Resync from repo" })
        .getAttribute("aria-disabled") === "true" ||
        within(dialog)
          .getByRole("button", { name: "Resync from repo" })
          .hasAttribute("disabled"),
    ).toBe(true);
    await user.click(
      within(dialog).getByRole("button", { name: "Check again" }),
    );
    expect(fns.planResync).toHaveBeenCalledTimes(2);
    expect(fns.resyncProduct).not.toHaveBeenCalled();
  });

  it("words a dry-run refusal for the check it failed", async () => {
    const user = userEvent.setup();
    fns.planResync.mockRejectedValue(
      new ApiError(
        422,
        undefined,
        "bad_request",
        ["product.tiers[0].id: required"],
        "manifest",
      ),
    );
    mount();
    await user.click(
      await screen.findByRole("button", { name: "Resync from repo…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(await within(dialog).findByText("1 problem in .pkey/")).toBeTruthy();
    expect(
      within(dialog).getByText("product.tiers[0].id: required"),
    ).toBeTruthy();
    await expectNoAxeViolations(dialog);
  });

  it("shows the admin group read-only on a repo-linked product (manifest-only, ST-01b)", async () => {
    mount();
    expect(await screen.findByText("djdl-admins")).toBeTruthy();
    expect(screen.queryByLabelText("Admin group")).toBeNull();
    expect(
      screen.getByText(/Set by adminGroup in .pkey\/product/),
    ).toBeTruthy();
  });

  it("has no admin group input on any product, and marks a stored one Not enforced (P0-47)", async () => {
    // A manual product used to edit it; nothing enforces it, so nothing edits it now.
    fns.product.mockResolvedValue({
      product: product({ releaseSource: "manual" }),
    });
    mount();
    const value = await screen.findByText("djdl-admins");
    expect(screen.queryByLabelText("Admin group")).toBeNull();
    expect(screen.queryByRole("textbox", { name: /Admin group/ })).toBeNull();
    const row = value.closest("[data-align]") as HTMLElement;
    expect(within(row).getByText("Not enforced")).toBeTruthy();
    expect(row.textContent).toContain(
      "Not enforced: console access is platform-wide.",
    );
    // A long group wraps under the label on a phone and reads from the left.
    expect(value.className).toContain("max-sm:text-left");
    cleanup();
    resetCore();
    // A product with no admin group shows no row at all.
    fns.product.mockResolvedValue({
      product: product({ releaseSource: "manual", adminGroup: null }),
    });
    mount();
    await screen.findByLabelText(/Display name/);
    expect(screen.queryByText("Admin group")).toBeNull();
  });

  it("asks before a save claims a manifest-owned value, and sends nothing on cancel (ST-01b)", async () => {
    const user = userEvent.setup();
    fns.updateProduct.mockResolvedValue({ ok: true, slug: "djdl" });
    mount();
    const name = await screen.findByLabelText(/Display name/);
    await user.clear(name);
    await user.type(name, "DJDL Pro");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    let dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/Saving sets Display name here/),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(fns.updateProduct).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save settings" }));
    dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Save and claim" }),
    );
    await waitFor(() =>
      expect(fns.updateProduct).toHaveBeenCalledWith("djdl", {
        name: "DJDL Pro",
      }),
    );
  });

  it("saves an already-claimed value without asking again", async () => {
    const user = userEvent.setup();
    fns.updateProduct.mockResolvedValue({ ok: true, slug: "djdl" });
    fns.product.mockResolvedValue({
      product: product({
        claims: [
          {
            key: "license.defaults.deviceLimit",
            claimedBy: "u1",
            claimedAt: 1_700_000_050,
            version: 1,
          },
        ],
      }),
    });
    mount();
    const limit = await screen.findByLabelText(/Default device limit/);
    await user.clear(limit);
    await user.type(limit, "8");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(fns.updateProduct).toHaveBeenCalledWith("djdl", {
        defaultDeviceLimit: 8,
      }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("reverts a claimed value to the manifest after an L1 confirm (ST-01b)", async () => {
    const user = userEvent.setup();
    fns.revertClaim.mockResolvedValue({
      ok: true,
      key: "core.name",
      applied: false,
      message: "applies at the next resync",
    });
    fns.product.mockResolvedValue({
      product: product({
        claims: [
          {
            key: "core.name",
            claimedBy: "u1",
            claimedAt: 1_700_000_050,
            version: 1,
          },
        ],
      }),
    });
    mount();
    await user.click(
      await screen.findByRole("button", { name: /Set in console/ }),
    );
    await user.click(await screen.findByRole("button", { name: "Revert…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Return display name to the manifest?"),
    ).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", { name: "Revert to manifest" }),
    );
    await waitFor(() =>
      expect(fns.revertClaim).toHaveBeenCalledWith("djdl", "core.name"),
    );
    expect(
      await screen.findByText(
        "Display name returns to the manifest at the next resync",
      ),
    ).toBeTruthy();
  });

  it("takes a system product edit only as a break-glass claim with a reason (L2, ST-20)", async () => {
    const user = userEvent.setup();
    fns.updateProduct.mockResolvedValue({
      ok: true,
      slug: "djdl",
      claimed: ["license.defaults.deviceLimit"],
      breakGlass: { expiresAt: 1_700_604_900 },
    });
    fns.product.mockResolvedValue({
      product: product({
        system: true,
        manifestAuthoritative: { value: true, locked: true },
      }),
    });
    mount();
    // The name stays the system product's; the deploy hook is its only writer, so no Resync.
    const name = await screen.findByLabelText(/Display name/);
    expect(
      name.hasAttribute("disabled") ||
        name.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    expect(
      screen.queryByRole("button", { name: "Resync from repo…" }),
    ).toBeNull();
    expect(screen.getByText("The deploy hook")).toBeTruthy();
    expect(screen.getByText("On, locked")).toBeTruthy();

    const limit = screen.getByLabelText(/Default device limit/);
    await user.clear(limit);
    await user.type(limit, "9");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    let dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Make a break-glass claim?")).toBeTruthy();
    // The open dialog passes axe, its reason field included.
    await expectNoAxeViolations(dialog);
    expect(
      within(dialog).getByText(/at the first deploy that changes the value/),
    ).toBeTruthy();
    const confirm = within(dialog).getByRole("button", {
      name: "Make break-glass claim",
    });
    // A reason is required.
    expect(confirm.hasAttribute("disabled")).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(fns.updateProduct).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save settings" }));
    dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByLabelText("Reason"), "  incident 42  ");
    await user.click(
      within(dialog).getByRole("button", { name: "Make break-glass claim" }),
    );
    await waitFor(() =>
      expect(fns.updateProduct).toHaveBeenCalledWith("djdl", {
        breakGlass: { reason: "incident 42" },
        defaultDeviceLimit: 9,
      }),
    );
  });

  it("says when a break-glass claim ends, on its row (ST-20)", async () => {
    fns.product.mockResolvedValue({
      product: product({
        manifestAuthoritative: { value: true, locked: false },
        claims: [
          {
            key: "license.defaults.deviceLimit",
            claimedBy: "u1",
            claimedAt: 1_700_000_050,
            version: 1,
            breakGlass: { reason: "incident 42", expiresAt: 1_700_604_850 },
          },
        ],
      }),
    });
    mount();
    expect(
      await screen.findByText(
        /Break-glass claim until .*, or the first resync that changes it in .pkey\/: incident 42/,
      ),
    ).toBeTruthy();
  });

  it("turns manifest-authoritative mode on after an L1 confirm (ST-20)", async () => {
    const user = userEvent.setup();
    fns.updateProduct.mockResolvedValue({ ok: true, slug: "djdl" });
    fns.product.mockResolvedValue({
      product: product({
        manifestAuthoritative: { value: false, locked: false },
      }),
    });
    mount();
    await user.click(
      await screen.findByRole("switch", { name: "Manifest-authoritative" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Make .pkey/ the only writer?"),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Turn on" }));
    await waitFor(() =>
      expect(fns.updateProduct).toHaveBeenCalledWith("djdl", {
        manifestAuthoritative: true,
      }),
    );
  });

  it("lists what a resync kept as set in the console", async () => {
    const user = userEvent.setup();
    fns.planResync.mockResolvedValue(RESYNC_PLAN);
    fns.resyncProduct.mockResolvedValue({
      ok: true,
      slug: "djdl",
      updated: ["product"],
      claimed: ["core.name", "tier:gold"],
      conflicts: [{ path: "/tiers/silver", message: "kept the console tier" }],
      // ST-20: every resync summary lists the live break-glass claims and the ended ones.
      breakGlass: [
        {
          key: "core.name",
          claimedBy: "u1",
          claimedAt: 1_700_000_050,
          reason: "incident 42",
          expiresAt: 1_700_604_850,
        },
      ],
      breakGlassEnded: [
        { key: "license.defaults.deviceLimit", why: "changed" },
      ],
    });
    mount();
    await user.click(
      await screen.findByRole("button", { name: "Resync from repo…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    // The confirm enables once the dry run's plan is in (UX-78).
    expect(await within(dialog).findByText("Tier studio added")).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", { name: "Resync from repo" }),
    );
    expect(
      await screen.findByText(
        "Kept as set in the console: Display name, tier gold.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/kept the console tier/)).toBeTruthy();
    expect(
      within(
        screen.getByRole("list", { name: "Break-glass claims" }),
      ).getByText(/Display name: break-glass claim until .* \(incident 42\)/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Break-glass claims ended: Default device limit (the manifest changed it).",
      ),
    ).toBeTruthy();
  });

  describe("Link repository (a manual product, EXPERIENCE.md §0.4 S1)", () => {
    const PLAN = {
      apply: [
        {
          area: "source",
          summary:
            "Source becomes acme/djdl: pushes to its default branch re-apply .pkey/",
        },
        { area: "tiers", id: "pro", summary: "Tier pro added" },
      ],
      skipClaimed: [
        {
          area: "services",
          summary:
            "Services stay as set in the console (the manifest turns on release)",
        },
      ],
      delete: [{ area: "tiers", id: "legacy", summary: "Tier legacy" }],
      conflicts: [] as { area: string; summary: string }[],
    };
    const CHECKED = {
      ok: true,
      dryRun: true,
      slug: "djdl",
      repository: "acme/djdl",
      manifestDigest: "d".repeat(64),
      plan: PLAN,
      remainingSecrets: ["OIDC_SECRET__DJDL"],
    };

    beforeEach(() => {
      fns.product.mockResolvedValue({
        product: product({ releaseSource: "manual", setup: undefined }),
      });
    });

    async function openDrawer(user: ReturnType<typeof userEvent.setup>) {
      mount();
      expect(
        screen.queryByRole("button", { name: /Resync from repo/ }),
      ).toBeNull();
      await user.click(
        await screen.findByRole("button", { name: "Link repository…" }),
      );
      return screen.findByRole("dialog", { name: "Link repository" });
    }

    it("checks, shows the plan, then links with the check's digest and reports what it applied", async () => {
      const user = userEvent.setup();
      fns.checkRepoLink.mockResolvedValue(CHECKED);
      fns.linkProductRepo.mockResolvedValue({
        ok: true,
        slug: "djdl",
        repository: "acme/djdl",
        plan: PLAN,
        updated: ["product", "schema", "tiers"],
        remainingSecrets: [],
      });
      const drawer = await openDrawer(user);
      const link = within(drawer).getByRole("button", {
        name: /^Link (repository|and remove)/,
      });
      expect(link.getAttribute("aria-disabled")).toBe("true");

      await user.type(
        within(drawer).getByRole("textbox", { name: /Repository/ }),
        "acme/djdl",
      );
      await user.click(within(drawer).getByRole("button", { name: "Check" }));
      expect(fns.checkRepoLink).toHaveBeenCalledWith("djdl", "acme/djdl");
      expect(await within(drawer).findByText("Tier pro added")).toBeTruthy();
      expect(
        within(drawer).getByText("Stays (set in the console)"),
      ).toBeTruthy();
      expect(within(drawer).getByText("Tier legacy")).toBeTruthy();
      // The plan removes a tier: the button says so.
      expect(
        within(drawer).getByRole("button", { name: "Link and remove 1" }),
      ).toBeTruthy();
      expect(within(drawer).getByText("OIDC_SECRET__DJDL")).toBeTruthy();
      await expectNoAxeViolations(drawer);

      await user.click(
        within(drawer).getByRole("button", {
          name: /^Link (repository|and remove)/,
        }),
      );
      await waitFor(() =>
        expect(fns.linkProductRepo).toHaveBeenCalledWith(
          "djdl",
          "acme/djdl",
          "d".repeat(64),
        ),
      );
      const panel = await screen.findByTestId("resync-result");
      expect(within(panel).getByText("Linked to acme/djdl")).toBeTruthy();
      expect(
        within(panel).getByText("Updated: product details, catalog, tiers."),
      ).toBeTruthy();
    });

    it("marks the check that failed and words its fix", async () => {
      const user = userEvent.setup();
      fns.checkRepoLink.mockRejectedValue(
        new ApiError(422, undefined, "bad_request", undefined, "app"),
      );
      const drawer = await openDrawer(user);
      await user.type(
        within(drawer).getByRole("textbox", { name: /Repository/ }),
        "acme/djdl",
      );
      await user.click(within(drawer).getByRole("button", { name: "Check" }));
      expect(
        (
          await within(drawer).findAllByText(
            "The Polaris Key GitHub App can't read acme/djdl",
          )
        ).length,
      ).toBeGreaterThan(0);
      const rows = within(drawer)
        .getByRole("list", { name: "Link checks" })
        .querySelectorAll("[data-step-state]");
      expect([...rows].map((r) => r.getAttribute("data-step-state"))).toEqual([
        "done",
        "failed",
        "todo",
        "todo",
        "todo",
      ]);
      expect(
        within(drawer).getByRole("button", { name: "Check again" }),
      ).toBeTruthy();
    });

    it("a manifest for another product names the slug to set", async () => {
      const user = userEvent.setup();
      const e = new ApiError(422, undefined, "bad_request", undefined, "slug");
      e.message = "manifest slug ghost does not match product djdl";
      fns.checkRepoLink.mockRejectedValue(e);
      const drawer = await openDrawer(user);
      await user.type(
        within(drawer).getByRole("textbox", { name: /Repository/ }),
        "acme/ghost",
      );
      await user.click(within(drawer).getByRole("button", { name: "Check" }));
      expect(
        await within(drawer).findByText(
          /Set product.slug in .pkey\/product to djdl, push, then check again/,
        ),
      ).toBeTruthy();
    });

    it("a conflict blocks the link, and editing the repository clears the check", async () => {
      const user = userEvent.setup();
      fns.checkRepoLink.mockResolvedValue({
        ...CHECKED,
        plan: {
          ...PLAN,
          conflicts: [
            {
              area: "tiers",
              summary:
                "Tier legacy is not in the manifest but 3 licenses use it: add it to .pkey/product or move them first",
            },
          ],
        },
      });
      const drawer = await openDrawer(user);
      const field = within(drawer).getByRole("textbox", { name: /Repository/ });
      await user.type(field, "acme/djdl");
      await user.click(within(drawer).getByRole("button", { name: "Check" }));
      expect(await within(drawer).findByText("Blocks the link")).toBeTruthy();
      const link = within(drawer).getByRole("button", {
        name: /^Link (repository|and remove)/,
      });
      expect(link.getAttribute("aria-disabled")).toBe("true");

      await user.type(field, "x");
      expect(within(drawer).queryByText("Blocks the link")).toBeNull();
      expect(fns.linkProductRepo).not.toHaveBeenCalled();
    });

    it("a push between the check and the link asks for a fresh check", async () => {
      const user = userEvent.setup();
      fns.checkRepoLink.mockResolvedValue(CHECKED);
      fns.linkProductRepo.mockRejectedValue(new ApiError(409));
      const drawer = await openDrawer(user);
      await user.type(
        within(drawer).getByRole("textbox", { name: /Repository/ }),
        "acme/djdl",
      );
      await user.click(within(drawer).getByRole("button", { name: "Check" }));
      await within(drawer).findByText("Tier pro added");
      await user.click(
        within(drawer).getByRole("button", {
          name: /^Link (repository|and remove)/,
        }),
      );
      expect(
        await within(drawer).findByText("The manifest changed since the check"),
      ).toBeTruthy();
      expect(within(drawer).queryByText("Tier pro added")).toBeNull();
    });
  });

  it("shows the blob collector's dry run", async () => {
    mount();
    expect(await screen.findByText("15 objects")).toBeTruthy();
    expect(screen.getByText(/1 week grace/)).toBeTruthy();
  });

  it("deletes the product only after the slug is typed (L3), sending it as confirmSlug, then goes Home", async () => {
    const user = userEvent.setup();
    fns.deleteProduct.mockResolvedValue({ ok: true, slug: "djdl" });
    mount();
    await user.click(
      await screen.findByRole("button", { name: "Delete product…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog)
        .getByRole("button", { name: "Delete product" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await user.type(
      within(dialog).getByLabelText(/Type the product slug/),
      "djdl",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Delete product" }),
    );
    await waitFor(() =>
      expect(fns.deleteProduct).toHaveBeenCalledWith("djdl", "djdl"),
    );
    await waitFor(() => expect(window.location.hash).toBe("#/"));
  });

  it("keeps the delete dialog open with the error when the server refuses", async () => {
    const user = userEvent.setup();
    fns.deleteProduct.mockRejectedValue(new ApiError(500));
    mount();
    await user.click(
      await screen.findByRole("button", { name: "Delete product…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.type(
      within(dialog).getByLabelText(/Type the product slug/),
      "djdl",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Delete product" }),
    );
    await waitFor(() => expect(fns.deleteProduct).toHaveBeenCalled());
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("shows an error state with Retry", async () => {
    const user = userEvent.setup();
    fns.product.mockRejectedValueOnce(new ApiError(500));
    mount();
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText(/Display name/)).toBeTruthy();
  });

  it("passes axe", async () => {
    const { container } = mount();
    await screen.findByText("15 objects");
    await expectNoAxeViolations(container);
  });
});
