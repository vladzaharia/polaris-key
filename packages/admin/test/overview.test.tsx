import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProductDetail, ServiceSlug } from "../src/api.js";
import { expectNoAxeViolations, renderAt, resetCore } from "./coreTestUtils.js";

const fns = vi.hoisted(() => ({
  product: vi.fn(),
  licenses: vi.fn(),
  productDeviceSummary: vi.fn(),
  schema: vi.fn(),
  profiles: vi.fn(),
  releases: vi.fn(),
  releaseHealth: vi.fn(),
  rollouts: vi.fn(),
  updateSettings: vi.fn(),
  portalSettings: vi.fn(),
  activity: vi.fn(),
  productKeys: vi.fn(),
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
const { OverviewPage } =
  await import("../src/console/sections/core/pages/Overview.js");

const NOW = Math.floor(Date.now() / 1000);
const ALL: ServiceSlug[] = [
  "license",
  "config",
  "release",
  "distribution",
  "update",
  "identity",
];

function enablement(on: ServiceSlug[]) {
  return Object.fromEntries(
    ALL.map((s) => [s, { enabled: on.includes(s) }]),
  ) as Record<ServiceSlug, { enabled: boolean }>;
}

function product(over: Partial<ProductDetail> = {}): ProductDetail {
  return {
    slug: "djdl",
    name: "DJDL",
    signingKid: "djdl-a",
    signing: { kid: "djdl-a", publicKey: "PUBKEY-A" },
    jwksUrl: "/djdl/.well-known/jwks.json",
    compatMin: "1.0.0",
    compatMax: "2.0.0",
    defaultMaxOfflineDays: 30,
    defaultDeviceLimit: 5,
    adminGroup: null,
    createdAt: NOW - 1000,
    modifiedAt: NOW,
    services: enablement(["license", "config"]),
    setup: {
      secrets: [
        {
          name: "WEBHOOK_SECRET",
          configured: false,
          sources: ["OIDC client secret"],
        },
      ],
      warnings: [],
    },
    ...over,
  };
}

function signingKey(kid: string, status: string, publicKey: string) {
  return {
    kid,
    status,
    alg: "EdDSA",
    publicKey,
    createdAt: NOW - 100,
    activateAfter: null,
    activatedAt: status === "active" ? NOW - 50 : null,
    retiredAt: null,
    revokedAt: null,
  };
}

const mount = () => renderAt("#/p/djdl", <OverviewPage slug="djdl" />);

beforeEach(() => {
  resetCore();
  for (const f of Object.values(fns)) f.mockReset();
  fns.product.mockResolvedValue({ product: product() });
  fns.licenses.mockResolvedValue({ licenses: [] });
  fns.productDeviceSummary.mockResolvedValue({
    total: 7,
    byStatus: [],
    licensed: { licensed: 0, licenseFree: 0 },
    byPlatform: [],
    byArch: [],
    bySdkName: [],
    byAppVersion: [],
  });
  fns.schema.mockResolvedValue({
    schemaVersion: 3,
    entries: [{ key: "a" }, { key: "b" }],
  });
  fns.profiles.mockResolvedValue({ profiles: [] });
  fns.releases.mockResolvedValue({
    releases: [
      {
        releaseId: "r1",
        version: "2.4.0",
        publishedAt: NOW,
        deliverable: "app",
        yank: null,
      },
    ],
    channels: [],
    floors: [],
  });
  fns.releaseHealth.mockResolvedValue({
    health: { healthy: true, status: "healthy", missing: [], checks: [] },
  });
  fns.rollouts.mockResolvedValue({ rollouts: [] });
  fns.updateSettings.mockResolvedValue({
    metadataAccess: "licensed",
    compatMin: "1.0.0",
    compatMax: "2.0.0",
  });
  fns.portalSettings.mockResolvedValue({
    settings: { portalEnabled: true, oidcEnabled: true, magicEnabled: false },
  });
  fns.activity.mockResolvedValue({ items: [], nextCursor: null });
  fns.productKeys.mockResolvedValue({
    keys: [
      signingKey("djdl-a", "active", "PUBKEY-A"),
      signingKey("djdl-old", "retired", "PUBKEY-OLD"),
    ],
    now: NOW,
  });
});
afterEach(cleanup);

describe("Core → Overview", () => {
  it("titles the page with the product and offers Create license when License is on (OVR-1)", async () => {
    mount();
    expect(
      await screen.findByRole("heading", { level: 1, name: "DJDL" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Create license" }).getAttribute("href"),
    ).toBe("#/p/djdl/license/licenses");
  });

  it("offers Publish catalog with only Config on, else Enable services", async () => {
    fns.product.mockResolvedValue({
      product: product({ services: enablement(["config"]) }),
    });
    mount();
    expect(
      await screen.findByRole("link", { name: "Publish catalog" }),
    ).toBeTruthy();
    cleanup();
    resetCore();
    fns.product.mockResolvedValue({
      product: product({ services: enablement([]) }),
    });
    mount();
    expect(
      (await screen.findAllByRole("link", { name: "Enable services" })).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("This product runs no services yet")).toBeTruthy();
  });

  it("draws a tile only for each enabled service, in that service's accent", async () => {
    mount();
    const license = await screen.findByRole("heading", {
      level: 2,
      name: "License",
    });
    expect(
      license.closest("[data-service]")?.getAttribute("data-service"),
    ).toBe("license");
    expect(
      screen.getByRole("heading", { level: 2, name: "Config" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { level: 2, name: "Release" }),
    ).toBeNull();
    expect(await screen.findByText("2 keys")).toBeTruthy();
    expect(await screen.findByText("7 devices")).toBeTruthy();
  });

  it("renders setup as a checklist with words, not colour, and links that go elsewhere (OVR-2, OVR-7)", async () => {
    mount();
    expect(await screen.findByText("Set secret WEBHOOK_SECRET")).toBeTruthy();
    expect(screen.getAllByText("Needs attention").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", { name: /^Set/ }).getAttribute("href"),
    ).toBe("#/p/djdl/keys");
    // No license yet: the step is to do, and links to Licenses.
    expect(await screen.findByText("Issue a first license")).toBeTruthy();
    for (const link of screen.getAllByRole("link"))
      expect(link.getAttribute("href")).not.toBe("#/p/djdl");
  });

  it("marks the first license done once a license exists", async () => {
    fns.licenses.mockResolvedValue({
      licenses: [{ id: "l1", status: "active", expiresAt: null }],
    });
    mount();
    expect(await screen.findByText("First license issued")).toBeTruthy();
  });

  it("omits License steps when License is off", async () => {
    fns.product.mockResolvedValue({
      product: product({ services: enablement(["config", "release"]) }),
    });
    mount();
    await screen.findByText("Set secret WEBHOOK_SECRET");
    expect(screen.queryByText("Issue a first license")).toBeNull();
    expect(fns.licenses).not.toHaveBeenCalled();
  });

  it("hides a complete checklist, with no healthy pill, behind a Setup checklist action", async () => {
    const user = userEvent.setup();
    fns.product.mockResolvedValue({
      product: product({ setup: { secrets: [] } }),
    });
    fns.licenses.mockResolvedValue({
      licenses: [{ id: "l1", status: "active", expiresAt: null }],
    });
    mount();
    const reopen = await screen.findByRole("button", {
      name: "Setup checklist",
    });
    // Pills mean attention: a finished setup draws no "Setup complete" pill anywhere.
    expect(screen.queryByText("Setup complete")).toBeNull();
    await user.click(reopen);
    expect(await screen.findByRole("heading", { name: "Setup" })).toBeTruthy();
  });

  it("lists licenses expiring soon under Needs attention", async () => {
    fns.licenses.mockResolvedValue({
      licenses: [{ id: "l1", status: "active", expiresAt: NOW + 3 * 86400 }],
    });
    mount();
    expect(
      await screen.findByRole("heading", { name: "Needs attention" }),
    ).toBeTruthy();
    expect(
      await screen.findByText("1 license expires within 14 days."),
    ).toBeTruthy();
  });

  it("shows the signing key in gold with copy, and a quick start that installs from pkg.plrs.im (UX-59)", async () => {
    fns.product.mockResolvedValue({
      product: product({
        services: enablement(["license", "config", "release"]),
      }),
    });
    mount();
    expect(await screen.findByText("PUBKEY-A")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Copy signing key/ }),
    ).toBeTruthy();
    const text = () => document.body.textContent ?? "";
    // The registry line comes before the install, never a bare npm install against npmjs.
    const registry =
      "@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/";
    expect(text()).toContain(registry);
    expect(text()).toContain("npm install @polaris-key/node");
    expect(text().indexOf(registry)).toBeLessThan(
      text().indexOf("npm install @polaris-key/node"),
    );
    // The app's own version is a placeholder, never the latest release's (2.4.0).
    expect(text()).toContain(
      `version: "1.0.0", // your app's version, not Polaris Key's`,
    );
    expect(text()).not.toContain('version: "2.4.0"');
    expect(text()).toContain('"djdl-a": "PUBKEY-A"');
    expect(text()).not.toContain("PUBKEY-OLD");
  });

  it("pins the active and the staged key, and offers every SDK (UX-59)", async () => {
    const user = userEvent.setup();
    fns.productKeys.mockResolvedValue({
      keys: [
        signingKey("djdl-b", "staged", "PUBKEY-B"),
        signingKey("djdl-a", "active", "PUBKEY-A"),
      ],
      now: NOW,
    });
    mount();
    expect(
      await screen.findByText(/Pins the active key and the key staged/),
    ).toBeTruthy();
    const text = () => document.body.textContent ?? "";
    expect(text()).toContain('"djdl-b": "PUBKEY-B"');
    const pick = async (label: string) => {
      await user.click(
        screen.getByRole("combobox", { name: "SDK quick start" }),
      );
      await user.click(await screen.findByRole("option", { name: label }));
    };
    await pick("Swift");
    expect(text()).toContain("import PolarisKey");
    expect(text()).toContain("swift/polaris-key");
    await pick("React and web");
    expect(text()).toContain("npm install @polaris-key/react");
    expect(text()).toContain("<PolarisKeyProvider");
    await pick("Python");
    expect(text()).toContain("https://pkg.plrs.im/pypi/polaris-key/simple/");
    expect(text()).toContain("from polaris_key import PolarisKeyClient");
    // pip installs the package alone: its description says to install the dependencies first.
    expect(text()).toContain("dependencies from your usual index");
    await pick("Kotlin and Android");
    expect(text()).toContain("https://pkg.plrs.im/maven/polaris-key/");
    expect(text()).toContain('"djdl-a" to "PUBKEY-A"');
    await pick("Godot");
    expect(text()).toContain(
      '[gd_resource type="Resource" script_class="PKeyOptions" load_steps=2 format=3]',
    );
    expect(text()).toContain("https://pkg.plrs.im/godot/polaris-key/");
  });

  it("shows an error state with Retry when the product cannot load", async () => {
    const user = userEvent.setup();
    fns.product.mockRejectedValueOnce(new ApiError(500));
    mount();
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "DJDL" }),
    ).toBeTruthy();
  });

  it("a failing tile shows its own error and leaves the page standing", async () => {
    fns.schema.mockRejectedValue(new ApiError(500));
    mount();
    const config = await screen.findByRole("heading", {
      level: 2,
      name: "Config",
    });
    const tile = config.closest("section")!;
    expect(
      await within(tile as HTMLElement).findByRole("button", { name: "Retry" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 1, name: "DJDL" }),
    ).toBeTruthy();
  });

  it("passes axe", async () => {
    const { container } = mount();
    await screen.findByText("2 keys");
    await expectNoAxeViolations(container);
  });
});
