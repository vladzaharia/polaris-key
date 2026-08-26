import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProductDetail, ReleaseHealth, ResyncResult } from "../src/api.js";
import { resetCache } from "../src/context.js";

const product = vi.fn<(slug: string) => Promise<{ product: ProductDetail }>>();
const resyncProduct = vi.fn<(slug: string) => Promise<ResyncResult>>();
const releaseHealth =
  vi.fn<(slug: string) => Promise<{ health: ReleaseHealth }>>();
vi.mock("../src/api.js", () => ({
  api: {
    product: (slug: string) => product(slug),
    resyncProduct: (slug: string) => resyncProduct(slug),
    releaseHealth: (slug: string) => releaseHealth(slug),
  },
}));

const { Releases } = await import("../src/views/Releases.js");

const PRODUCT: ProductDetail = {
  slug: "djdl",
  name: "DJDL",
  signingKid: "kid-2026",
  compatMin: "1.0.0",
  compatMax: "2.0.0",
  defaultMaxOfflineDays: 14,
  defaultDeviceLimit: 3,
  adminGroup: "djdl-admins",
  // Resync is a repo-linked-only action, so the fixture has to say which kind of product
  // this is; `releaseSourceOf` defaults an absent value to "manual".
  releaseSource: "github",
  setup: {
    sync: {
      source: "webhook",
      status: "ok",
      lastCheckedAt: 1_720_000_000,
      lastSyncedAt: 1_720_000_000,
      commitSha: "abc123",
      changedPaths: [".pkey/product.yaml"],
      updated: ["product", "release"],
      errors: [],
      message: null,
    },
  },
  createdAt: 1_700_000_000,
  modifiedAt: 1_710_000_000,
};

const HEALTH: ReleaseHealth = {
  status: "healthy",
  healthy: true,
  missing: [],
  release: {
    tag: "v1.2.3",
    name: "1.2.3",
    prerelease: false,
    assetCount: 5,
    htmlUrl: "https://github.com/acme/djdl/releases/tag/v1.2.3",
  },
  checks: [
    {
      id: "github",
      label: "GitHub access",
      status: "ok",
      message: "Listed 1 release.",
    },
    {
      id: "sparkle-signature",
      label: "Sparkle signature",
      status: "ok",
      message: "Found djdl-arm64.dmg.sig.",
    },
  ],
};

beforeEach(() => {
  resetCache();
  product.mockReset();
  resyncProduct.mockReset();
  releaseHealth.mockReset();
  product.mockResolvedValue({ product: PRODUCT });
  releaseHealth.mockResolvedValue({ health: HEALTH });
  (
    Element.prototype as unknown as { hasPointerCapture: () => boolean }
  ).hasPointerCapture = () => false;
  (
    Element.prototype as unknown as { scrollIntoView: () => void }
  ).scrollIntoView = () => undefined;
});
afterEach(cleanup);

describe("Releases view", () => {
  it("renders the read-only product/release metadata and the manifest note", async () => {
    render(<Releases slug="djdl" />);

    expect(await screen.findByText("DJDL")).toBeTruthy();
    expect(screen.getByText("kid-2026")).toBeTruthy();
    expect(screen.getByText("min 1.0.0")).toBeTruthy();
    expect(screen.getByText("max 2.0.0")).toBeTruthy();
    expect(screen.getByText("djdl-admins")).toBeTruthy();
    expect(await screen.findByText("v1.2.3")).toBeTruthy();
    expect(screen.getByText("GitHub access")).toBeTruthy();
    expect(screen.getByText(".pkey/product.yaml")).toBeTruthy();
    expect(screen.getByText("product")).toBeTruthy();
    expect(screen.getByText("release")).toBeTruthy();

    // The note explaining release config lives in the repo manifest.
    expect(screen.getByText(/managed from the repo manifest/i)).toBeTruthy();
  });

  it("resyncs from the repo via the confirm dialog, calling resyncProduct", async () => {
    resyncProduct.mockResolvedValue({ ok: true, slug: "djdl" });
    render(<Releases slug="djdl" />);
    await screen.findByText("DJDL");

    await userEvent.click(
      screen.getByRole("button", { name: /Resync from repo/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Resync" }),
    );

    await waitFor(() => expect(resyncProduct).toHaveBeenCalledWith("djdl"));
  });

  it("disables resync for a product that is not linked to a repo", async () => {
    // `release/resync.ts` returns "product is not linked to a repo" (422) for any product
    // whose `release_source` is not `github`, so an enabled button here is an affordance the
    // server is guaranteed to refuse.
    product.mockResolvedValue({
      product: { ...PRODUCT, releaseSource: "manual" },
    });
    render(<Releases slug="djdl" />);
    await screen.findByText("DJDL");

    const button = screen.getByRole("button", { name: /Resync from repo/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    await userEvent.click(button);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(resyncProduct).not.toHaveBeenCalled();
  });

  it("shows an error state with retry when the product fails to load", async () => {
    product.mockReset();
    product
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValueOnce({ product: PRODUCT });
    render(<Releases slug="djdl" />);

    expect(await screen.findByText("Couldn’t load the product")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("DJDL")).toBeTruthy();
  });
});
