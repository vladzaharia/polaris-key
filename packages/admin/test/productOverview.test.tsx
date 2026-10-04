import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ProductDetail } from "../src/api.js";
import { resetCache } from "../src/context.js";
import { Toaster } from "../src/components/ui/index.js";
import { ProductOverview } from "../src/views/ProductOverview.js";

// The product Overview's setup checklist (moved here from products.test.tsx in chunk 4, when the
// Products page moved onto the console harness; the Overview itself is chunk 5's). The `api`
// module is fully mocked so the view's rendering is asserted in isolation.
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

describe("Product overview setup checklist", () => {
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
    ).toBe("#/p/djdl/keys");
    expect(
      screen
        .getByRole("link", { name: /Create test license/ })
        .getAttribute("href"),
    ).toBe("#/p/djdl/license/licenses");
  });

  it("omits the License checklist items when License is disabled", async () => {
    mockApi.product.mockResolvedValue({
      product: {
        ...MANUAL,
        services: {
          license: { enabled: false },
          config: { enabled: true },
          release: { enabled: true },
          update: { enabled: false },
          identity: { enabled: false },
        },
        setup: { healthy: true, nextActions: [] },
      },
    });
    render(
      <Toaster>
        <ProductOverview slug="djdl" />
      </Toaster>,
    );

    expect(await screen.findByText("Guided checklist")).toBeTruthy();
    expect(screen.getByText("Required secrets")).toBeTruthy();
    expect(screen.queryByText("Issue a license")).toBeNull();
    expect(screen.queryByText("License defaults")).toBeNull();
  });
});
