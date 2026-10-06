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
  it("saves only what changed, sending a cleared admin group as null (A-3, PRD-6)", async () => {
    const user = userEvent.setup();
    fns.updateProduct.mockResolvedValue({ ok: true, slug: "djdl" });
    mount();
    const group = await screen.findByLabelText("Admin group");
    await user.clear(group);
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(fns.updateProduct).toHaveBeenCalledWith("djdl", {
        adminGroup: null,
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

  it("resyncs after an L1 confirm and lists what it did (RSY-3)", async () => {
    const user = userEvent.setup();
    fns.resyncProduct.mockResolvedValue({
      ok: true,
      slug: "djdl",
      updated: ["services", "catalog"],
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
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Resync from repo" }),
    );
    expect(
      await screen.findByText("Re-applied: services, catalog."),
    ).toBeTruthy();
    expect(screen.getByText(/kept the previous keys/)).toBeTruthy();
    expect(screen.getByText("Pack sets resolved: 2.")).toBeTruthy();
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
      expect(await screen.findByText("Linked to acme/djdl")).toBeTruthy();
      expect(
        screen.getByText("Re-applied: product, schema, tiers."),
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
