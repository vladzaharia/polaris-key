import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProductDetail } from "../src/api.js";
import { resetCache } from "../src/context.js";
import { Toaster } from "../src/components/ui/index.js";
import { Products } from "../src/views/Products.js";
import { ProductOverview } from "../src/views/ProductOverview.js";

// The Products view is the only unit under test; the `api` module is fully mocked so the
// component's behavior (rendering + which methods each flow calls) is asserted in isolation.
vi.mock("../src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api.js")>();
  return {
    ...actual,
    api: {
      product: vi.fn(),
      products: vi.fn(),
      createManualProduct: vi.fn(),
      linkRepo: vi.fn(),
      updateProduct: vi.fn(),
      deleteProduct: vi.fn(),
      resyncProduct: vi.fn(),
      putProductSecret: vi.fn(),
      rotateProductKey: vi.fn(),
    },
  };
});

// Imported AFTER the mock factory above so we get the mocked instance.
import { api } from "../src/api.js";

const mockApi = api as unknown as {
  product: ReturnType<typeof vi.fn>;
  products: ReturnType<typeof vi.fn>;
  createManualProduct: ReturnType<typeof vi.fn>;
  linkRepo: ReturnType<typeof vi.fn>;
  updateProduct: ReturnType<typeof vi.fn>;
  deleteProduct: ReturnType<typeof vi.fn>;
  resyncProduct: ReturnType<typeof vi.fn>;
  putProductSecret: ReturnType<typeof vi.fn>;
  rotateProductKey: ReturnType<typeof vi.fn>;
};

const MANUAL: ProductDetail = {
  slug: "djdl",
  name: "DJDL",
  signingKid: "manual:1",
  compatMin: "1.0.0",
  compatMax: "2.0.0",
  defaultMaxOfflineDays: 14,
  defaultDeviceLimit: 3,
  adminGroup: "pkey-djdl-admins",
  createdAt: 1_700_000_000,
  modifiedAt: 1_700_100_000,
};

const GITHUB: ProductDetail = {
  ...MANUAL,
  slug: "acme",
  name: "Acme",
  signingKid: "gh:abc123",
  releaseSource: "github",
  adminGroup: null,
};

function renderProducts() {
  return render(
    <Toaster>
      <Products />
    </Toaster>,
  );
}

beforeEach(() => {
  resetCache();
  vi.clearAllMocks();
  mockApi.product.mockResolvedValue({ product: MANUAL });
  mockApi.products.mockResolvedValue({ products: [MANUAL, GITHUB] });
  // jsdom lacks these Radix-needed APIs.
  (
    Element.prototype as unknown as { hasPointerCapture: () => boolean }
  ).hasPointerCapture = () => false;
  (
    Element.prototype as unknown as { scrollIntoView: () => void }
  ).scrollIntoView = () => undefined;
});

afterEach(cleanup);

describe("Products view", () => {
  it("renders the product list with slug, name, and inferred release source", async () => {
    renderProducts();
    expect(await screen.findByText("djdl")).toBeTruthy();
    expect(screen.getByText("Acme")).toBeTruthy();
    // The GitHub-sourced product gets a GitHub badge; the manual one a Manual badge.
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByText("Manual")).toBeTruthy();
  });

  it("shows the empty state when there are no products", async () => {
    mockApi.products.mockResolvedValue({ products: [] });
    renderProducts();
    expect(await screen.findByText("No products yet")).toBeTruthy();
  });

  it("surfaces an error state with a retry affordance", async () => {
    mockApi.products.mockRejectedValue(new Error("boom"));
    renderProducts();
    expect(await screen.findByText("Couldn’t load products")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy();
  });

  it("renders setup as an actionable checklist", async () => {
    mockApi.product.mockResolvedValue({
      product: {
        ...MANUAL,
        setup: {
          healthy: false,
          missingSecrets: ["WEBHOOK_SECRET"],
          warnings: ["GitHub app is not installed"],
          nextActions: [
            { id: "releases", label: "Configure releases", route: "releases" },
          ],
        },
      },
    });
    render(
      <Toaster>
        <ProductOverview slug="djdl" />
      </Toaster>,
    );

    expect(await screen.findByText("Guided checklist")).toBeTruthy();
    expect(screen.getByText("Required secrets")).toBeTruthy();
    // The missing secret legitimately renders twice since the metric card and the
    // checklist both report missingSecrets (it previously appeared once only because
    // the metric card was reading the wrong field).
    expect(screen.getAllByText(/WEBHOOK_SECRET/).length).toBeGreaterThanOrEqual(
      2,
    );
    expect(screen.getByText("Review setup warning")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Set secrets/ }).getAttribute("href"),
    ).toBe("#/p/djdl/secrets");
    expect(
      screen
        .getByRole("link", { name: /Create test license/ })
        .getAttribute("href"),
    ).toBe("#/p/djdl/licenses");
  });

  it("creates a manual product via createManualProduct and shows the returned kid", async () => {
    mockApi.createManualProduct.mockResolvedValue({
      ok: true,
      slug: "newp",
      kid: "manual:42",
      product: null,
    });
    renderProducts();
    await screen.findByText("djdl");

    await userEvent.click(screen.getByRole("button", { name: /New product/ }));
    const dialog = await screen.findByRole("dialog");

    // The Manual tab is the default; fill the required slug and submit.
    expect(within(dialog).getByRole("tab", { name: /Manual/ })).toBeTruthy();
    expect(
      within(dialog).getByRole("tab", { name: /From GitHub/ }),
    ).toBeTruthy();
    expect(within(dialog).getByRole("tab", { name: "Basics" })).toBeTruthy();
    expect(within(dialog).getByRole("tab", { name: "Catalog" })).toBeTruthy();
    expect(within(dialog).getByRole("tab", { name: "Defaults" })).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText(/Slug/), "newp");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create product" }),
    );

    await waitFor(() =>
      expect(mockApi.createManualProduct).toHaveBeenCalledTimes(1),
    );
    expect(mockApi.createManualProduct.mock.calls[0]![0]).toMatchObject({
      slug: "newp",
    });
    // The success panel surfaces the returned kid.
    expect(await screen.findByText("manual:42")).toBeTruthy();
  });

  it("links a repo via linkRepo and lists the remaining secrets", async () => {
    mockApi.linkRepo.mockResolvedValue({
      ok: true,
      slug: "linked",
      kid: "gh:99",
      remainingSecrets: ["GITHUB_APP_PRIVATE_KEY", "WEBHOOK_SECRET"],
    });
    renderProducts();
    await screen.findByText("djdl");

    await userEvent.click(screen.getByRole("button", { name: /New product/ }));
    const dialog = await screen.findByRole("dialog");

    // Switch to the GitHub tab.
    await userEvent.click(
      within(dialog).getByRole("tab", { name: /From GitHub/ }),
    );
    await userEvent.type(
      within(dialog).getByLabelText(/Repository URL/),
      "https://github.com/acme/linked",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Link repository" }),
    );

    await waitFor(() => expect(mockApi.linkRepo).toHaveBeenCalledTimes(1));
    expect(mockApi.linkRepo).toHaveBeenCalledWith(
      "https://github.com/acme/linked",
    );
    expect(await screen.findByText("GITHUB_APP_PRIVATE_KEY")).toBeTruthy();
    expect(screen.getByText("WEBHOOK_SECRET")).toBeTruthy();
  });

  it("surfaces an aggregated manifest error from link-repo", async () => {
    const err = Object.assign(new Error("manifest invalid"), {
      fields: ["name missing", "bad schema"],
    });
    mockApi.linkRepo.mockRejectedValue(err);
    renderProducts();
    await screen.findByText("djdl");

    await userEvent.click(screen.getByRole("button", { name: /New product/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("tab", { name: /From GitHub/ }),
    );
    await userEvent.type(
      within(dialog).getByLabelText(/Repository URL/),
      "https://github.com/acme/bad",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Link repository" }),
    );

    expect(await screen.findByText(/manifest invalid/)).toBeTruthy();
    expect(screen.getByText(/name missing/)).toBeTruthy();
  });

  it("confirms before deleting and calls deleteProduct on confirm", async () => {
    mockApi.deleteProduct.mockResolvedValue({ ok: true, slug: "djdl" });
    renderProducts();
    await screen.findByText("djdl");

    await userEvent.click(
      screen.getByRole("button", { name: "Actions for djdl" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Delete/ }),
    );

    // A confirm dialog gates the destructive call.
    const confirmDialog = await screen.findByRole("alertdialog");
    expect(within(confirmDialog).getByText(/Disable “djdl”\?/)).toBeTruthy();
    expect(mockApi.deleteProduct).not.toHaveBeenCalled();

    await userEvent.click(
      within(confirmDialog).getByRole("button", { name: "Disable product" }),
    );
    await waitFor(() =>
      expect(mockApi.deleteProduct).toHaveBeenCalledWith("djdl"),
    );
  });

  it("prepares the signing key and shows the new public key", async () => {
    mockApi.rotateProductKey.mockResolvedValue({
      ok: true,
      kid: "manual:2",
      publicKey: "PUBKEY-XYZ",
    });
    renderProducts();
    await screen.findByText("djdl");

    await userEvent.click(
      screen.getByRole("button", { name: "Actions for djdl" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Prepare signing key/ }),
    );

    const confirmDialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(confirmDialog).getByRole("button", { name: "Prepare key" }),
    );

    await waitFor(() =>
      expect(mockApi.rotateProductKey).toHaveBeenCalledWith("djdl"),
    );
    expect(await screen.findByText("PUBKEY-XYZ")).toBeTruthy();
  });

  it("sets a write-only secret via putProductSecret", async () => {
    mockApi.putProductSecret.mockResolvedValue({ ok: true, name: "TOKEN" });
    renderProducts();
    await screen.findByText("djdl");

    await userEvent.click(
      screen.getByRole("button", { name: "Actions for djdl" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Set secret/ }),
    );

    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/Secret name/), "TOKEN");
    await userEvent.type(
      within(dialog).getByLabelText(/Secret value/),
      "s3cr3t",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Set secret" }),
    );

    await waitFor(() =>
      // No usage chosen: none is sent, so an existing secret keeps its usage (P0-12).
      expect(mockApi.putProductSecret).toHaveBeenCalledWith(
        "djdl",
        "TOKEN",
        "s3cr3t",
        undefined,
      ),
    );
  });

  it("offers resync only for GitHub-sourced products", async () => {
    renderProducts();
    await screen.findByText("djdl");

    // GitHub-sourced "acme" exposes resync...
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for acme" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: /Resync from GitHub/ }),
    ).toBeTruthy();
    await userEvent.keyboard("{Escape}");

    // ...the manual "djdl" does not.
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for djdl" }),
    );
    await screen.findByRole("menuitem", { name: /Prepare signing key/ });
    expect(
      screen.queryByRole("menuitem", { name: /Resync from GitHub/ }),
    ).toBeNull();
  });
});
