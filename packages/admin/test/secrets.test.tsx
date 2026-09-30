import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ApiError,
  type EdgeMintRecipe,
  type EdgeMintRecipesResponse,
  type ProductDetail,
} from "../src/api.js";
import { resetCache } from "../src/context.js";
import { Toaster } from "../src/components/ui/index.js";
import { Secrets } from "../src/views/Secrets.js";

vi.mock("../src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api.js")>();
  return {
    ...actual,
    api: {
      product: vi.fn(),
      putProductSecret: vi.fn(),
      edgeMintRecipes: vi.fn(),
      approveEdgeMintRecipe: vi.fn(),
      revokeEdgeMintRecipe: vi.fn(),
    },
  };
});

import { api } from "../src/api.js";

const mockApi = api as unknown as {
  product: ReturnType<typeof vi.fn>;
  putProductSecret: ReturnType<typeof vi.fn>;
  edgeMintRecipes: ReturnType<typeof vi.fn>;
  approveEdgeMintRecipe: ReturnType<typeof vi.fn>;
  revokeEdgeMintRecipe: ReturnType<typeof vi.fn>;
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

const FIELDS = {
  alg: "ES256",
  signingKeySecret: "EDGE_MINT__DJDL__APPLEMUSIC",
  kid: "KID1",
  claimsTemplateJson: '{"iss":"TEAM"}',
  ttlSeconds: 3600,
  audience: null,
};

function recipe(over: Partial<EdgeMintRecipe> = {}): EdgeMintRecipe {
  return {
    id: "applemusic",
    ...FIELDS,
    claimsTemplate: { iss: "TEAM" },
    status: "pending",
    secretUsage: "edge-mint",
    approval: null,
    changedFields: [],
    ...over,
  };
}

function recipes(
  list: EdgeMintRecipe[],
  registration: EdgeMintRecipesResponse["registration"] = "requires-license",
): EdgeMintRecipesResponse {
  return { registration, recipes: list };
}

function renderSecrets() {
  return render(
    <Toaster>
      <Secrets slug="djdl" />
    </Toaster>,
  );
}

async function pick(comboboxName: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole("combobox", { name: comboboxName }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

beforeEach(() => {
  resetCache();
  vi.clearAllMocks();
  mockApi.product.mockResolvedValue({ product: PRODUCT });
  mockApi.edgeMintRecipes.mockResolvedValue(recipes([]));
  // jsdom lacks these Radix-needed APIs.
  (
    Element.prototype as unknown as { hasPointerCapture: () => boolean }
  ).hasPointerCapture = () => false;
  (
    Element.prototype as unknown as { scrollIntoView: () => void }
  ).scrollIntoView = () => undefined;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
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

  it("sets a write-only secret via putProductSecret, sending no usage by default", async () => {
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
        undefined,
      ),
    );
  });

  it("marks a secret edge-mint when that usage is chosen (P0-12)", async () => {
    mockApi.putProductSecret.mockResolvedValue({
      ok: true,
      name: "KEY",
      usage: "edge-mint",
    });
    renderSecrets();
    await userEvent.type(await screen.findByLabelText("Secret name"), "KEY");
    await userEvent.type(screen.getByLabelText("Value"), "pem");
    await pick("Usage", "Edge-mint signing key");
    await userEvent.click(screen.getByRole("button", { name: "Set secret" }));
    await waitFor(() =>
      expect(mockApi.putProductSecret).toHaveBeenCalledWith(
        "djdl",
        "KEY",
        "pem",
        "edge-mint",
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

describe("Edge-mint recipes card (P0-12)", () => {
  it("is absent when the product declares no recipes", async () => {
    renderSecrets();
    await screen.findByText("Required secrets");
    await waitFor(() => expect(mockApi.edgeMintRecipes).toHaveBeenCalled());
    expect(screen.queryByText("Edge-mint recipes")).toBeNull();
  });

  it("approves a pending recipe by echoing exactly the fields shown", async () => {
    mockApi.edgeMintRecipes.mockResolvedValue(recipes([recipe()]));
    mockApi.approveEdgeMintRecipe.mockResolvedValue({
      ok: true,
      id: "applemusic",
      status: "approved",
    });
    renderSecrets();
    expect(await screen.findByText("Edge-mint recipes")).toBeTruthy();
    expect(screen.getByText("Pending approval")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Approve" }),
    );
    await waitFor(() =>
      expect(mockApi.approveEdgeMintRecipe).toHaveBeenCalledWith(
        "djdl",
        "applemusic",
        FIELDS,
        false,
      ),
    );
  });

  it("on open registration, warns and requires the acknowledgement before approving", async () => {
    mockApi.edgeMintRecipes.mockResolvedValue(recipes([recipe()], "open"));
    mockApi.approveEdgeMintRecipe.mockResolvedValue({ ok: true });
    renderSecrets();
    await screen.findByText("Edge-mint recipes");
    expect(screen.getByText(/public token mint/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Approve" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(mockApi.approveEdgeMintRecipe).toHaveBeenCalledWith(
        "djdl",
        "applemusic",
        FIELDS,
        true,
      ),
    );
  });

  it("shows what changed since approval and offers re-approval and revoke", async () => {
    mockApi.edgeMintRecipes.mockResolvedValue(
      recipes([
        recipe({
          status: "changed",
          ttlSeconds: 86400,
          approval: {
            ...FIELDS,
            openRegistrationAcknowledged: false,
            approvedAt: 1_700_000_000,
            approvedBy: "migration",
          },
          changedFields: ["ttlSeconds"],
        }),
      ]),
    );
    mockApi.revokeEdgeMintRecipe.mockResolvedValue({
      ok: true,
      id: "applemusic",
      status: "pending",
    });
    renderSecrets();
    expect(await screen.findByText("Changed since approval")).toBeTruthy();
    expect(screen.getByText("3600")).toBeTruthy(); // the approved value
    expect(screen.getByRole("button", { name: "Re-approve" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Revoke" }),
    );
    await waitFor(() =>
      expect(mockApi.revokeEdgeMintRecipe).toHaveBeenCalledWith(
        "djdl",
        "applemusic",
      ),
    );
  });

  it("explains a recipe whose approval predates open registration, and re-approves with the acknowledgement", async () => {
    mockApi.edgeMintRecipes.mockResolvedValue(
      recipes(
        [
          recipe({
            status: "changed",
            approval: {
              ...FIELDS,
              openRegistrationAcknowledged: false,
              approvedAt: 1_700_000_000,
              approvedBy: "op-1",
            },
            changedFields: ["registration"],
          }),
        ],
        "open",
      ),
    );
    mockApi.approveEdgeMintRecipe.mockResolvedValue({
      ok: true,
      id: "applemusic",
      status: "approved",
    });
    renderSecrets();
    expect(
      await screen.findByText(/Registration became open after this recipe/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Re-approve" }));
    const dialog = await screen.findByRole("dialog");
    const approve = within(dialog).getByRole("button", { name: "Approve" });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(approve);
    await waitFor(() =>
      expect(mockApi.approveEdgeMintRecipe).toHaveBeenCalledWith(
        "djdl",
        "applemusic",
        FIELDS,
        true,
      ),
    );
  });

  it("flags a signing secret that is not marked edge-mint", async () => {
    mockApi.edgeMintRecipes.mockResolvedValue(
      recipes([recipe({ secretUsage: "general" })]),
    );
    renderSecrets();
    expect(await screen.findByText("general — cannot sign")).toBeTruthy();
  });

  it("reports a stale approval (409) instead of approving", async () => {
    mockApi.edgeMintRecipes.mockResolvedValue(recipes([recipe()]));
    mockApi.approveEdgeMintRecipe.mockRejectedValue(new ApiError(409));
    renderSecrets();
    await screen.findByText("Edge-mint recipes");
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Approve" }),
    );
    expect(
      await screen.findByText("The recipe changed — review it again"),
    ).toBeTruthy();
    // The list is reloaded so the operator sees the recipe as it now stands.
    await waitFor(() =>
      expect(mockApi.edgeMintRecipes.mock.calls.length).toBeGreaterThan(1),
    );
  });
});
