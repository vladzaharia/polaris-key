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
const { KeysPage, refreshedCopy } =
  await import("../src/console/pages/core/Keys.js");

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
      sync: { enabled: false },
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

  it("opens Set secret with the name from ?secret= (C-7)", async () => {
    renderAt(
      "#/p/djdl/keys?secret=OIDC_CLIENT_SECRET",
      <KeysPage slug="djdl" />,
    );
    const drawer = await screen.findByRole("dialog", {
      name: "Set OIDC_CLIENT_SECRET",
    });
    expect(
      (within(drawer).getByLabelText(/^Name/) as HTMLInputElement).value,
    ).toBe("OIDC_CLIENT_SECRET");
    // The name is given, so first focus is on the value.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(drawer).getByLabelText(/^Value/),
      ),
    );
    expect(within(drawer).getByText("Never shown again.")).toBeTruthy();
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
  it("lists every key with its state", async () => {
    mount();
    expect((await screen.findAllByText("djdl-a")).length).toBeGreaterThan(0);
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Staged")).toBeTruthy();
    expect(screen.getAllByText(/^Retired/).length).toBeGreaterThan(0);
  });

  it("a staged key opens the rotation strip: the window counts down and Activate waits with the reason (UX-29)", async () => {
    mount();
    const strip = await screen.findByRole("list", { name: "Key rotation" });
    const steps = within(strip).getAllByRole("listitem");
    for (const [i, title] of [
      "Prepared",
      "Trust window",
      "Activate",
      "Old key retires",
    ].entries()) {
      expect(steps[i]!.textContent).toContain(title);
    }
    expect(steps[0]!.textContent).toContain("(completed)");
    expect(steps[1]!.getAttribute("aria-current")).toBe("step");
    expect(within(steps[1]!).getByText("4:00")).toBeTruthy();
    expect(within(steps[3]!).getByText("djdl-a")).toBeTruthy();
    const activate = screen.getByRole("button", { name: "Activate djdl-b…" });
    expect(activate.getAttribute("aria-disabled")).toBe("true");
    // The staged row carries no controls of its own: the strip owns the rotation.
    expect(
      screen.queryByRole("button", { name: "More actions for djdl-b" }),
    ).toBeNull();
  });

  it("Prepare is disabled with the reason while a rotation is in progress", async () => {
    mount();
    await screen.findByRole("list", { name: "Key rotation" });
    const prepare = screen.getByRole("button", { name: "Prepare signing key" });
    expect(prepare.getAttribute("aria-disabled")).toBe("true");
  });

  it("with no rotation in progress there is no strip and Prepare is enabled", async () => {
    const base = keys();
    fns.productKeys.mockResolvedValue({
      ...base,
      keys: base.keys.filter((k) => k.status !== "staged"),
    });
    mount();
    await screen.findAllByText("djdl-a");
    expect(screen.queryByRole("list", { name: "Key rotation" })).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Prepare signing key" })
        .getAttribute("aria-disabled"),
    ).toBeNull();
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
    const strip = await screen.findByRole("list", { name: "Key rotation" });
    const steps = within(strip).getAllByRole("listitem");
    expect(steps[2]!.getAttribute("aria-current")).toBe("step");
    await user.click(screen.getByRole("button", { name: "Activate djdl-b…" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Activate" }));
    await waitFor(() =>
      expect(fns.activateProductKey).toHaveBeenCalledWith("djdl", "djdl-b"),
    );
    await waitFor(() =>
      expect(fns.productKeys.mock.calls.length).toBeGreaterThan(1),
    );
  });

  it("break-glass activation is L3 from the strip's overflow: the kid is typed once", async () => {
    fns.activateProductKey.mockResolvedValue({ ok: true });
    mount();
    await screen.findAllByText("djdl-b");
    const user = await openRowMenu("More rotation actions");
    await user.click(
      await screen.findByRole("menuitem", { name: /break-glass/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", {
      name: "Activate now",
    });
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    // The label names the field and the code shows the value: the kid appears once, not twice.
    const input = within(dialog).getByLabelText(
      /Type the key id/,
    ) as HTMLInputElement;
    expect(input.labels?.[0]?.textContent).toBe("Type the key id djdl-b");
    await user.type(input, "djdl-b");
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

  it("cancelling a rotation retires the staged key (L1)", async () => {
    fns.retireProductKey.mockResolvedValue({ ok: true });
    mount();
    await screen.findAllByText("djdl-b");
    const user = await openRowMenu("More rotation actions");
    await user.click(
      await screen.findByRole("menuitem", { name: /Cancel rotation/ }),
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: /Cancel the rotation to djdl-b/,
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Retire djdl-b" }),
    );
    await waitFor(() =>
      expect(fns.retireProductKey).toHaveBeenCalledWith("djdl", "djdl-b"),
    );
  });

  it("after a rotation, one line says how many active devices refreshed (UX-29, §0.9)", async () => {
    const base = keys();
    fns.productKeys.mockResolvedValue({
      ...base,
      keys: base.keys.filter((k) => k.status !== "staged"),
      refresh: {
        kid: "djdl-a",
        activatedAt: NOW - 3 * 86_400,
        activeDevices: 1310,
        refreshedDevices: 1204,
        windowDays: 30,
      },
    });
    mount();
    expect(
      await screen.findByText(
        "91% of active devices have refreshed since djdl-a went live.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/1,204 of 1,310 seen in the last 30 days/),
    ).toBeTruthy();
    expect(screen.queryByText(/fetched/)).toBeNull();
  });

  it("revokes a retired key only after the kid is typed (L3)", async () => {
    fns.revokeProductKey.mockResolvedValue({ ok: true });
    mount();
    await screen.findByText("djdl-z");
    const user = await openRowMenu("More actions for djdl-z");
    await user.click(await screen.findByRole("menuitem", { name: "Revoke…" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByLabelText(/Type the key id/), "djdl-z");
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(fns.revokeProductKey).toHaveBeenCalledWith("djdl", "djdl-z"),
    );
  });

  it("prepares a key (L1) and the list refreshes", async () => {
    const user = userEvent.setup();
    const base = keys();
    fns.productKeys.mockResolvedValue({
      ...base,
      keys: base.keys.filter((k) => k.status !== "staged"),
    });
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
    expect((await screen.findAllByText("djdl-a")).length).toBeGreaterThan(0);
  });
});

describe("refreshedCopy", () => {
  const r = {
    kid: "k2",
    activatedAt: 0,
    activeDevices: 3,
    refreshedDevices: 2,
    windowDays: 30,
  };
  it("rounds down, so it never claims every device before every device is back", () => {
    expect(
      refreshedCopy({ ...r, activeDevices: 1000, refreshedDevices: 999 }),
    ).toBe("99% of active devices have refreshed since k2 went live.");
    expect(refreshedCopy({ ...r, refreshedDevices: 3 })).toBe(
      "100% of active devices have refreshed since k2 went live.",
    );
  });
  it("says so plainly when no device was active", () => {
    expect(refreshedCopy({ ...r, activeDevices: 0, refreshedDevices: 0 })).toBe(
      "No device has been active in the last 30 days, so none has refreshed since k2 went live.",
    );
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
  it("holds signing keys, secrets and CI only: edge mint and store credentials have their own pages (SEC-1)", async () => {
    fns.product.mockResolvedValue({
      product: product({
        services: {
          ...product().services!,
          config: { enabled: true },
          distribution: { enabled: true },
        },
      }),
    });
    mount();
    await screen.findAllByText("djdl-a");
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual(["Signing keys", "Secrets", "CI publishing"]);
    expect(screen.queryByText("Edge-mint recipes")).toBeNull();
    expect(screen.queryByText("Outlet credentials")).toBeNull();
  });

  it("shows an error state when the product cannot load", async () => {
    fns.product.mockRejectedValue(new ApiError(500));
    mount();
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("passes axe", async () => {
    const { container } = mount();
    await screen.findByText("EDGE_KEY");
    await screen.findAllByText("djdl-a");
    await expectNoAxeViolations(container);
  });
});
