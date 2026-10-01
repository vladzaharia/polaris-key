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
  type EdgeMintIdentity,
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
      outletCredentials: vi.fn(),
      putOutletCredential: vi.fn(),
      deleteOutletCredential: vi.fn(),
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
  outletCredentials: ReturnType<typeof vi.fn>;
  putOutletCredential: ReturnType<typeof vi.fn>;
  deleteOutletCredential: ReturnType<typeof vi.fn>;
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

const IDENTITY: EdgeMintIdentity = {
  provider: "custom",
  issuer: "https://id.example",
  clientId: "djdl-client",
  groupRoleMapJson: '{"staff":{"role":"user","tier":"pro"}}',
};

function recipes(
  list: EdgeMintRecipe[],
  registration: EdgeMintRecipesResponse["registration"] = "requires-license",
  anonymousEnroll = false,
  extra: {
    identity?: EdgeMintIdentity | null;
    oidcDefault?: boolean;
    licenseEnabled?: boolean;
  } = {},
): EdgeMintRecipesResponse {
  const oidcDefault = extra.oidcDefault ?? false;
  return {
    registration,
    anonymousEnroll,
    oidcDefault,
    publicMint: registration === "open" || anonymousEnroll || oidcDefault,
    licenseEnabled: extra.licenseEnabled ?? true,
    identity: extra.identity ?? null,
    recipes: list,
  };
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
  mockApi.outletCredentials.mockResolvedValue({
    ok: true,
    kinds: [],
    credentials: [],
  });
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
        null,
        true,
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
        null,
        true,
        true,
      ),
    );
  });

  it("with anonymous enrolment on a closed product, warns and requires the acknowledgement", async () => {
    mockApi.edgeMintRecipes.mockResolvedValue(
      recipes([recipe()], "requires-license", true),
    );
    mockApi.approveEdgeMintRecipe.mockResolvedValue({ ok: true });
    renderSecrets();
    await screen.findByText("Edge-mint recipes");
    expect(screen.getByText(/public token mint/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(
      /The mint is public: anonymous enrolment is on\./,
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/I understand anonymous enrolment is on/),
    ).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "Approve" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(mockApi.approveEdgeMintRecipe).toHaveBeenCalledWith(
        "djdl",
        "applemusic",
        FIELDS,
        null,
        true,
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
            licenseEnabled: true,
            identity: null,
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
              licenseEnabled: true,
              identity: null,
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
      await screen.findByText(
        /The mint became public \(registration is open\) after this recipe/,
      ),
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
        null,
        true,
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
      await screen.findByText(
        "The recipe, its sign-in trust or License changed — review it again",
      ),
    ).toBeTruthy();
    // The list is reloaded so the operator sees the recipe as it now stands.
    await waitFor(() =>
      expect(mockApi.edgeMintRecipes.mock.calls.length).toBeGreaterThan(1),
    );
  });
  it("with Identity on, shows the sign-in trust and echoes it on approve", async () => {
    mockApi.edgeMintRecipes.mockResolvedValue(
      recipes([recipe()], "requires-license", false, { identity: IDENTITY }),
    );
    mockApi.approveEdgeMintRecipe.mockResolvedValue({ ok: true });
    renderSecrets();
    await screen.findByText("Edge-mint recipes");
    expect(
      screen.getByText(/signing in also hands out device tokens/),
    ).toBeTruthy();
    expect(screen.getAllByText("https://id.example").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/Devices can also get tokens by signing in/),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Approve" }),
    );
    await waitFor(() =>
      expect(mockApi.approveEdgeMintRecipe).toHaveBeenCalledWith(
        "djdl",
        "applemusic",
        FIELDS,
        IDENTITY,
        true,
        false,
      ),
    );
  });

  it("explains a recipe whose sign-in trust changed, with the approved issuer beside the new one", async () => {
    mockApi.edgeMintRecipes.mockResolvedValue(
      recipes(
        [
          recipe({
            status: "changed",
            approval: {
              ...FIELDS,
              openRegistrationAcknowledged: false,
              licenseEnabled: true,
              identity: IDENTITY,
              approvedAt: 1_700_000_000,
              approvedBy: "op-1",
            },
            changedFields: ["identity"],
          }),
        ],
        "requires-license",
        false,
        {
          identity: { ...IDENTITY, issuer: "https://idp.attacker.example" },
        },
      ),
    );
    renderSecrets();
    expect(
      await screen.findByText(
        /Sign-in now trusts a different identity provider or group map/,
      ),
    ).toBeTruthy();
    expect(screen.getByText("https://id.example")).toBeTruthy();
    expect(screen.getByText(/approved as:/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Re-approve" })).toBeTruthy();
  });

  it("explains a recipe whose approval predates License being turned off", async () => {
    mockApi.edgeMintRecipes.mockResolvedValue(
      recipes(
        [
          recipe({
            status: "changed",
            approval: {
              ...FIELDS,
              openRegistrationAcknowledged: false,
              licenseEnabled: true,
              identity: IDENTITY,
              approvedAt: 1_700_000_000,
              approvedBy: "op-1",
            },
            changedFields: ["license"],
          }),
        ],
        "requires-identity",
        false,
        { identity: IDENTITY, licenseEnabled: false },
      ),
    );
    renderSecrets();
    expect(
      await screen.findByText(/License was turned off after this recipe/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Re-approve" })).toBeTruthy();
  });

  it("while License is off, warns on the card and in the dialog and echoes License off", async () => {
    // What an operator sees after a push turned License off and the ingest dropped the
    // approval: the recipe is plain `pending`, so the reason must come from the card itself.
    mockApi.edgeMintRecipes.mockResolvedValue(
      recipes([recipe()], "requires-identity", false, {
        identity: IDENTITY,
        licenseEnabled: false,
      }),
    );
    mockApi.approveEdgeMintRecipe.mockResolvedValue({ ok: true });
    renderSecrets();
    await screen.findByText("Edge-mint recipes");
    expect(screen.getByText("Pending approval")).toBeTruthy();
    expect(screen.getByTestId("edge-mint-license-off").textContent).toMatch(
      /License is off.*does not check device\s+licences.*disabled or expired licence can mint/s,
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByTestId("edge-mint-approve-license-off").textContent,
    ).toMatch(/License is off: this mint does not check device licences/);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Approve" }),
    );
    await waitFor(() =>
      expect(mockApi.approveEdgeMintRecipe).toHaveBeenCalledWith(
        "djdl",
        "applemusic",
        FIELDS,
        IDENTITY,
        false,
        false,
      ),
    );
  });

  it("shows no License warning while License is on", async () => {
    mockApi.edgeMintRecipes.mockResolvedValue(recipes([recipe()]));
    renderSecrets();
    await screen.findByText("Edge-mint recipes");
    expect(screen.queryByTestId("edge-mint-license-off")).toBeNull();
  });

  it("with an OIDC default tier, warns that the mint is public and requires the acknowledgement", async () => {
    mockApi.edgeMintRecipes.mockResolvedValue(
      recipes([recipe()], "requires-license", false, {
        identity: IDENTITY,
        oidcDefault: true,
      }),
    );
    mockApi.approveEdgeMintRecipe.mockResolvedValue({ ok: true });
    renderSecrets();
    await screen.findByText("Edge-mint recipes");
    expect(screen.getByRole("alert").textContent).toMatch(
      /every account that can sign in gets a default tier/,
    );
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
        IDENTITY,
        true,
        true,
      ),
    );
  });
});

describe("Outlet credentials card (P5-01)", () => {
  const CRED = {
    id: "asc-team-key",
    kind: "asc-api-key",
    outletId: "app-store",
    meta: { keyId: "ABC123DEFG", issuerId: "issuer-1" },
    status: "active",
    createdAt: 1_700_000_000,
    createdBy: "admin-1",
    rotatedAt: null,
    expiresAt: null,
    lastUsedAt: null,
    lastOkAt: null,
    lastError: "401 from App Store Connect",
  };

  it("lists metadata and health, never a value", async () => {
    mockApi.outletCredentials.mockResolvedValue({
      ok: true,
      kinds: [],
      credentials: [CRED],
    });
    renderSecrets();
    const table = await screen.findByRole("table", {
      name: "Outlet credentials",
    });
    expect(within(table).getByText("asc-team-key")).toBeTruthy();
    expect(within(table).getByText("App Store Connect API key")).toBeTruthy();
    expect(within(table).getByText("ABC123DEFG · issuer-1")).toBeTruthy();
    expect(within(table).getByText("app-store")).toBeTruthy();
    expect(within(table).getByText("never")).toBeTruthy();
    expect(within(table).getByText("Error")).toBeTruthy();
  });

  it("sets an App Store Connect key write-only and clears the form", async () => {
    mockApi.putOutletCredential.mockResolvedValue({
      ok: true,
      id: "asc-team-key",
    });
    renderSecrets();
    const form = await screen.findByRole("form", {
      name: "Set an outlet credential",
    });
    await userEvent.type(
      within(form).getByLabelText("Credential id"),
      "asc-team-key",
    );
    await userEvent.type(
      within(form).getByLabelText("Outlet (optional)"),
      "app-store",
    );
    await userEvent.type(within(form).getByLabelText("Key ID"), "ABC123DEFG");
    await userEvent.type(within(form).getByLabelText("Issuer ID"), "issuer-1");
    await userEvent.type(within(form).getByLabelText(".p8 private key"), "PEM");
    await userEvent.click(
      within(form).getByRole("button", { name: "Set credential" }),
    );
    await waitFor(() =>
      expect(mockApi.putOutletCredential).toHaveBeenCalledWith(
        "djdl",
        "asc-team-key",
        {
          kind: "asc-api-key",
          value: { keyId: "ABC123DEFG", issuerId: "issuer-1", p8: "PEM" },
          outletId: "app-store",
        },
      ),
    );
    await waitFor(() =>
      expect(
        (within(form).getByLabelText(".p8 private key") as HTMLTextAreaElement)
          .value,
      ).toBe(""),
    );
  });

  it("sends a Google key as its JSON file", async () => {
    mockApi.putOutletCredential.mockResolvedValue({ ok: true, id: "play" });
    renderSecrets();
    const form = await screen.findByRole("form", {
      name: "Set an outlet credential",
    });
    await userEvent.type(within(form).getByLabelText("Credential id"), "play");
    await pick("Kind", "Google service account");
    await userEvent.type(within(form).getByLabelText("JSON key file"), "{{}");
    await userEvent.click(
      within(form).getByRole("button", { name: "Set credential" }),
    );
    await waitFor(() =>
      expect(mockApi.putOutletCredential).toHaveBeenCalledWith("djdl", "play", {
        kind: "google-service-account",
        value: "{}",
        outletId: null,
      }),
    );
  });

  it("requires an id and every field of the kind", async () => {
    renderSecrets();
    const form = await screen.findByRole("form", {
      name: "Set an outlet credential",
    });
    await userEvent.click(
      within(form).getByRole("button", { name: "Set credential" }),
    );
    expect(within(form).getByText("A credential id is required.")).toBeTruthy();
    await userEvent.type(within(form).getByLabelText("Credential id"), "x");
    await userEvent.click(
      within(form).getByRole("button", { name: "Set credential" }),
    );
    expect(within(form).getByText("Key ID is required.")).toBeTruthy();
    expect(mockApi.putOutletCredential).not.toHaveBeenCalled();
  });

  it("deletes a credential after confirmation", async () => {
    mockApi.outletCredentials.mockResolvedValue({
      ok: true,
      kinds: [],
      credentials: [CRED],
    });
    mockApi.deleteOutletCredential.mockResolvedValue({
      ok: true,
      id: "asc-team-key",
    });
    renderSecrets();
    await userEvent.click(
      await screen.findByRole("button", { name: "Delete asc-team-key" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete" }),
    );
    await waitFor(() =>
      expect(mockApi.deleteOutletCredential).toHaveBeenCalledWith(
        "djdl",
        "asc-team-key",
      ),
    );
  });
});
