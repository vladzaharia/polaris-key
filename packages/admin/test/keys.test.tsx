import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProductDetail, SigningKeysResponse } from "../src/api.js";
import { expectNoAxeViolations, renderAt, resetCore } from "./coreTestUtils.js";

const fns = vi.hoisted(() => ({
  product: vi.fn(),
  productKeys: vi.fn(),
  productSecrets: vi.fn(),
  putProductSecret: vi.fn(),
  rotateProductKey: vi.fn(),
  activateProductKey: vi.fn(),
  retireProductKey: vi.fn(),
  revokeProductKey: vi.fn(),
  ciPublisher: vi.fn(),
  putCiPublisher: vi.fn(),
  ciTokens: vi.fn(),
  issueCiToken: vi.fn(),
  revokeCiToken: vi.fn(),
  edgeMintRecipes: vi.fn(),
  outletCredentials: vi.fn(),
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
const { KeysPage } = await import("../src/console/pages/core/Keys.js");

const NOW = 1_800_000_000;

function product(over: Partial<ProductDetail> = {}): ProductDetail {
  return {
    slug: "djdl",
    name: "DJDL",
    signingKid: "djdl-a",
    jwksUrl: "/djdl/.well-known/jwks.json",
    compatMin: "1.0.0",
    compatMax: "2.0.0",
    defaultMaxOfflineDays: 30,
    defaultDeviceLimit: 5,
    adminGroup: null,
    createdAt: NOW - 1000,
    modifiedAt: NOW - 10,
    services: {
      license: { enabled: true },
      config: { enabled: false },
      release: { enabled: false },
      distribution: { enabled: false },
      update: { enabled: false },
      identity: { enabled: false },
    },
    setup: {
      secrets: [
        {
          name: "OIDC_CLIENT_SECRET",
          configured: false,
          sources: ["OIDC client secret"],
        },
      ],
    },
    ...over,
  };
}

function keys(now = NOW): SigningKeysResponse {
  return {
    now,
    keys: [
      {
        kid: "djdl-a",
        status: "active",
        alg: "Ed25519",
        publicKey: "PUB-A",
        createdAt: NOW - 1000,
        activateAfter: null,
        activatedAt: NOW - 1000,
        retiredAt: null,
        revokedAt: null,
      },
      {
        kid: "djdl-b",
        status: "staged",
        alg: "Ed25519",
        publicKey: "PUB-B",
        createdAt: NOW - 60,
        activateAfter: NOW + 240,
        activatedAt: null,
        retiredAt: null,
        revokedAt: null,
      },
      {
        kid: "djdl-z",
        status: "retired",
        alg: "Ed25519",
        publicKey: "PUB-Z",
        createdAt: NOW - 5000,
        activateAfter: null,
        activatedAt: null,
        retiredAt: NOW - 1000,
        revokedAt: null,
      },
    ],
  };
}

const mount = () => renderAt("#/p/djdl/keys", <KeysPage slug="djdl" />);

beforeEach(() => {
  resetCore();
  for (const f of Object.values(fns)) f.mockReset();
  fns.product.mockResolvedValue({ product: product() });
  fns.productKeys.mockResolvedValue(keys());
  fns.productSecrets.mockResolvedValue({
    secrets: [
      {
        name: "EDGE_KEY",
        configured: true,
        usage: "edge-mint",
        createdAt: NOW - 100,
        updatedAt: NOW - 100,
        requiredBy: ["Edge mint studio"],
      },
      {
        name: "OIDC_CLIENT_SECRET",
        configured: false,
        usage: null,
        createdAt: null,
        updatedAt: null,
        requiredBy: ["OIDC client secret"],
      },
    ],
  });
  fns.ciPublisher.mockResolvedValue({ ok: true, policy: null });
  fns.ciTokens.mockResolvedValue({ ok: true, tokens: [] });
  fns.edgeMintRecipes.mockResolvedValue({ recipes: [] });
  fns.outletCredentials.mockResolvedValue({
    ok: true,
    kinds: [],
    credentials: [],
  });
});
afterEach(cleanup);

async function openRowMenu(name: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name }));
  return user;
}

describe("Keys & secrets → Secrets", () => {
  it("lists stored and required secrets with usage, status and what requires each (SEC-2)", async () => {
    mount();
    expect(await screen.findByText("EDGE_KEY")).toBeTruthy();
    expect(screen.getByText("Edge-mint signing key")).toBeTruthy();
    expect(screen.getByText("Configured")).toBeTruthy();
    expect(screen.getByText("Missing")).toBeTruthy();
    expect(screen.getByText("OIDC client secret")).toBeTruthy();
  });

  it("a required row's Set… preselects its name (SEC-4)", async () => {
    mount();
    await screen.findByText("OIDC_CLIENT_SECRET");
    const user = await openRowMenu("Actions for OIDC_CLIENT_SECRET");
    await user.click(await screen.findByRole("menuitem", { name: "Set…" }));
    const drawer = await screen.findByRole("dialog");
    expect(
      (within(drawer).getByLabelText(/^Name/) as HTMLInputElement).value,
    ).toBe("OIDC_CLIENT_SECRET");
  });

  it("sets a write-only secret, sending no usage by default", async () => {
    const user = userEvent.setup();
    fns.putProductSecret.mockResolvedValue({ ok: true, name: "TOKEN" });
    mount();
    await user.click(
      (await screen.findAllByRole("button", { name: "Set secret" }))[0]!,
    );
    const drawer = await screen.findByRole("dialog");
    await user.type(within(drawer).getByLabelText(/^Name/), "TOKEN");
    await user.type(within(drawer).getByLabelText(/^Value/), "s3cr3t");
    await user.click(
      within(drawer).getByRole("button", { name: "Save secret" }),
    );
    await waitFor(() =>
      expect(fns.putProductSecret).toHaveBeenCalledWith(
        "djdl",
        "TOKEN",
        "s3cr3t",
        undefined,
      ),
    );
    // The inventory refetches after the write (A-5 invalidation).
    await waitFor(() =>
      expect(fns.productSecrets.mock.calls.length).toBeGreaterThan(1),
    );
  });

  it("marks a secret edge-mint when that usage is chosen (P0-12)", async () => {
    const user = userEvent.setup();
    fns.putProductSecret.mockResolvedValue({
      ok: true,
      name: "KEY",
      usage: "edge-mint",
    });
    mount();
    await user.click(
      (await screen.findAllByRole("button", { name: "Set secret" }))[0]!,
    );
    const drawer = await screen.findByRole("dialog");
    await user.type(within(drawer).getByLabelText(/^Name/), "KEY");
    await user.type(within(drawer).getByLabelText(/^Value/), "pem");
    await user.click(within(drawer).getByRole("combobox"));
    await user.click(
      await screen.findByRole("option", { name: "Edge-mint signing key" }),
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Save secret" }),
    );
    await waitFor(() =>
      expect(fns.putProductSecret).toHaveBeenCalledWith(
        "djdl",
        "KEY",
        "pem",
        "edge-mint",
      ),
    );
  });

  it("validates the name and value, and replacing a configured value needs the tick (SEC-3)", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(
      (await screen.findAllByRole("button", { name: "Set secret" }))[0]!,
    );
    const drawer = await screen.findByRole("dialog");
    await user.click(
      within(drawer).getByRole("button", { name: "Save secret" }),
    );
    expect(within(drawer).getByText("Enter the secret's name.")).toBeTruthy();
    expect(within(drawer).getByText("Enter a value.")).toBeTruthy();
    await user.type(within(drawer).getByLabelText(/^Name/), "EDGE_KEY");
    await user.click(
      within(drawer).getByRole("button", { name: "Save secret" }),
    );
    expect(
      within(drawer).getByText(/Replace the existing value” to overwrite/),
    ).toBeTruthy();
    expect(fns.putProductSecret).not.toHaveBeenCalled();
  });
});

describe("Keys & secrets → Signing keys (A-4)", () => {
  it("lists every key with its state; a staged key counts down to its trust window (SET-1)", async () => {
    mount();
    expect(await screen.findByText("djdl-a")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Staged")).toBeTruthy();
    expect(screen.getAllByText(/^Retired/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Activatable in 4 min/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Activate…" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("activates a staged key once its window has ended (L1)", async () => {
    const user = userEvent.setup();
    fns.productKeys.mockResolvedValue(keys(NOW + 600));
    fns.activateProductKey.mockResolvedValue({
      ok: true,
      kid: "djdl-b",
      status: "active",
    });
    mount();
    await user.click(await screen.findByRole("button", { name: "Activate…" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Activate" }));
    await waitFor(() =>
      expect(fns.activateProductKey).toHaveBeenCalledWith("djdl", "djdl-b"),
    );
    await waitFor(() =>
      expect(fns.productKeys.mock.calls.length).toBeGreaterThan(1),
    );
  });

  it("break-glass activation is L3: the kid must be typed", async () => {
    fns.activateProductKey.mockResolvedValue({ ok: true });
    mount();
    await screen.findByText("djdl-b");
    const user = await openRowMenu("More actions for djdl-b");
    await user.click(
      await screen.findByRole("menuitem", { name: /break-glass/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", {
      name: "Activate now",
    });
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    await user.type(within(dialog).getByLabelText(/Type djdl-b/), "djdl-b");
    await user.click(
      within(dialog).getByRole("button", { name: "Activate now" }),
    );
    await waitFor(() =>
      expect(fns.activateProductKey).toHaveBeenCalledWith(
        "djdl",
        "djdl-b",
        true,
      ),
    );
  });

  it("revokes a retired key only after the kid is typed (L3)", async () => {
    fns.revokeProductKey.mockResolvedValue({ ok: true });
    mount();
    await screen.findByText("djdl-z");
    const user = await openRowMenu("More actions for djdl-z");
    await user.click(await screen.findByRole("menuitem", { name: "Revoke…" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByLabelText(/Type djdl-z/), "djdl-z");
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(fns.revokeProductKey).toHaveBeenCalledWith("djdl", "djdl-z"),
    );
  });

  it("prepares a key (L1) and the list refreshes", async () => {
    const user = userEvent.setup();
    fns.rotateProductKey.mockResolvedValue({
      ok: true,
      kid: "djdl-c",
      publicKey: "P",
    });
    mount();
    await user.click(
      await screen.findByRole("button", { name: "Prepare signing key" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Prepare signing key" }),
    );
    await waitFor(() =>
      expect(fns.rotateProductKey).toHaveBeenCalledWith("djdl"),
    );
    await waitFor(() =>
      expect(fns.productKeys.mock.calls.length).toBeGreaterThan(1),
    );
  });

  it("shows a key list error with Retry", async () => {
    const user = userEvent.setup();
    fns.productKeys.mockRejectedValueOnce(new ApiError(500));
    mount();
    await user.click(
      (await screen.findAllByRole("button", { name: "Retry" }))[0]!,
    );
    expect(await screen.findByText("djdl-a")).toBeTruthy();
  });
});

describe("Keys & secrets → CI publishing", () => {
  it("issues a static token and shows it once", async () => {
    const user = userEvent.setup();
    fns.issueCiToken.mockResolvedValue({
      ok: true,
      token: "pkeyci_secret",
      tokenId: "cit_1",
      expiresAt: NOW,
      scopes: ["release:publish"],
    });
    mount();
    await user.click(
      await screen.findByRole("button", { name: "Issue token…" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Issue a CI token",
    });
    await user.type(within(dialog).getByLabelText("Label"), "Buildkite");
    await user.click(
      within(dialog).getByRole("button", { name: "Issue token" }),
    );
    await waitFor(() =>
      expect(fns.issueCiToken).toHaveBeenCalledWith("djdl", {
        scopes: ["release:publish"],
        expiresInDays: 30,
        label: "Buildkite",
      }),
    );
    expect(await screen.findByText("pkeyci_secret")).toBeTruthy();
  });

  it("shows the trusted publisher with its owner", async () => {
    fns.ciPublisher.mockResolvedValue({
      ok: true,
      policy: {
        product: "djdl",
        provider: "github",
        repositoryId: 1,
        repositoryOwnerId: 2,
        repository: "acme/djdl",
        workflow: ".github/workflows/release.yml",
        environment: "production",
        scopes: ["release:publish"],
        source: "manifest",
        createdAt: NOW,
        modifiedAt: NOW,
        modifiedBy: null,
      },
    });
    mount();
    expect(await screen.findByText("acme/djdl")).toBeTruthy();
    expect(screen.getAllByText("From manifest").length).toBeGreaterThan(0);
  });

  it("revokes a token after an L2 confirm", async () => {
    fns.ciTokens.mockResolvedValue({
      ok: true,
      tokens: [
        {
          tokenId: "cit_1",
          kind: "static",
          scopes: ["release:publish"],
          subject: "static:cit_1",
          label: "Buildkite",
          issuedAt: Math.floor(Date.now() / 1000) - 10,
          expiresAt: Math.floor(Date.now() / 1000) + 1000,
          revokedAt: null,
          createdBy: "u1",
        },
      ],
    });
    fns.revokeCiToken.mockResolvedValue({ ok: true });
    mount();
    await screen.findByText("Buildkite");
    const user = await openRowMenu("Actions for Buildkite");
    await user.click(await screen.findByRole("menuitem", { name: "Revoke…" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Revoke token" }),
    );
    await waitFor(() =>
      expect(fns.revokeCiToken).toHaveBeenCalledWith("djdl", "cit_1"),
    );
  });
});

describe("Keys & secrets → the page", () => {
  it("mounts store credentials only while Distribution is on, and no edge mint (SEC-1)", async () => {
    mount();
    await screen.findByText("djdl-a");
    expect(screen.queryByText("Store credentials")).toBeNull();
    expect(screen.queryByText("Edge-mint recipes")).toBeNull();
    cleanup();
    resetCore();
    fns.product.mockResolvedValue({
      product: product({
        services: { ...product().services!, distribution: { enabled: true } },
      }),
    });
    mount();
    expect(
      await screen.findByRole("heading", {
        name: "Store credentials",
      }),
    ).toBeTruthy();
    expect(await screen.findByText("Outlet credentials")).toBeTruthy();
  });

  it("shows an error state when the product cannot load", async () => {
    fns.product.mockRejectedValue(new ApiError(500));
    mount();
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("passes axe", async () => {
    const { container } = mount();
    await screen.findByText("EDGE_KEY");
    await screen.findByText("djdl-a");
    await expectNoAxeViolations(container);
  });
});
