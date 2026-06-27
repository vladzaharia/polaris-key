import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProductDetail } from "../src/api.js";
import { resetCache } from "../src/context.js";
import { Toaster } from "../src/components/ui/index.js";
import { Secrets } from "../src/views/Secrets.js";

vi.mock("../src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api.js")>();
  return {
    ...actual,
    api: { product: vi.fn(), putProductSecret: vi.fn() },
  };
});

import { api } from "../src/api.js";

const mockApi = api as unknown as {
  product: ReturnType<typeof vi.fn>;
  putProductSecret: ReturnType<typeof vi.fn>;
};

const PRODUCT: ProductDetail = {
  slug: "djdl",
  name: "DJDL",
  signingKid: "djdl-2026",
  compatMin: "0.0.0",
  compatMax: "99.0.0",
  defaultMaxOfflineDays: 30,
  defaultDeviceLimit: 5,
  adminGroup: "admins",
  createdAt: 1_700_000_000,
  modifiedAt: 1_700_100_000,
  setup: {
    secrets: [
      {
        name: "EDGE_MINT__DJDL__APPLEMUSIC",
        configured: false,
        sources: ["Edge mint applemusic"],
      },
    ],
  },
};

function renderSecrets() {
  return render(
    <Toaster>
      <Secrets slug="djdl" />
    </Toaster>,
  );
}

beforeEach(() => {
  resetCache();
  vi.clearAllMocks();
  mockApi.product.mockResolvedValue({ product: PRODUCT });
});

afterEach(cleanup);

describe("Secrets view", () => {
  it("lists required secrets with their configured status", async () => {
    renderSecrets();
    expect(await screen.findByText("Required secrets")).toBeTruthy();
    expect(screen.getByText("EDGE_MINT__DJDL__APPLEMUSIC")).toBeTruthy();
    expect(screen.getByText("Missing")).toBeTruthy();
  });

  it("prefills the name when a required secret is clicked", async () => {
    renderSecrets();
    await userEvent.click(
      await screen.findByText("EDGE_MINT__DJDL__APPLEMUSIC"),
    );
    expect(
      (screen.getByLabelText("Secret name") as HTMLInputElement).value,
    ).toBe("EDGE_MINT__DJDL__APPLEMUSIC");
  });

  it("sets a write-only secret via putProductSecret", async () => {
    mockApi.putProductSecret.mockResolvedValue({ ok: true, name: "TOKEN" });
    renderSecrets();
    await userEvent.type(await screen.findByLabelText("Secret name"), "TOKEN");
    await userEvent.type(screen.getByLabelText("Value"), "s3cr3t");
    await userEvent.click(screen.getByRole("button", { name: "Set secret" }));
    await waitFor(() =>
      expect(mockApi.putProductSecret).toHaveBeenCalledWith(
        "djdl",
        "TOKEN",
        "s3cr3t",
      ),
    );
  });

  it("validates that name and value are required", async () => {
    renderSecrets();
    await screen.findByLabelText("Secret name");
    await userEvent.click(screen.getByRole("button", { name: "Set secret" }));
    expect(screen.getByText("A secret name is required.")).toBeTruthy();
    expect(screen.getByText("A value is required.")).toBeTruthy();
    expect(mockApi.putProductSecret).not.toHaveBeenCalled();
  });
});
