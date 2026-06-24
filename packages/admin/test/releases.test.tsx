import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProductDetail, ResyncResult } from "../src/api.js";
import { resetCache } from "../src/context.js";

const product = vi.fn<(slug: string) => Promise<{ product: ProductDetail }>>();
const resyncProduct = vi.fn<(slug: string) => Promise<ResyncResult>>();
vi.mock("../src/api.js", () => ({
  api: {
    product: (slug: string) => product(slug),
    resyncProduct: (slug: string) => resyncProduct(slug),
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
  defaultMachineLimit: 3,
  adminGroup: "djdl-admins",
  createdAt: 1_700_000_000,
  modifiedAt: 1_710_000_000,
};

beforeEach(() => {
  resetCache();
  product.mockReset();
  resyncProduct.mockReset();
  product.mockResolvedValue({ product: PRODUCT });
  (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () => false;
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined;
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

    // The note explaining release config lives in the repo manifest.
    expect(screen.getByText(/managed from the repo manifest/i)).toBeTruthy();
  });

  it("resyncs from the repo via the confirm dialog, calling resyncProduct", async () => {
    resyncProduct.mockResolvedValue({ ok: true, slug: "djdl" });
    render(<Releases slug="djdl" />);
    await screen.findByText("DJDL");

    await userEvent.click(screen.getByRole("button", { name: /Resync from repo/ }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Resync" }));

    await waitFor(() => expect(resyncProduct).toHaveBeenCalledWith("djdl"));
  });

  it("shows an error state with retry when the product fails to load", async () => {
    product.mockReset();
    product.mockRejectedValueOnce(new Error("nope")).mockResolvedValueOnce({ product: PRODUCT });
    render(<Releases slug="djdl" />);

    expect(await screen.findByText("Couldn’t load the product")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("DJDL")).toBeTruthy();
  });
});
