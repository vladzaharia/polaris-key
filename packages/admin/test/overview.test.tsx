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
const { OverviewPage } = await import("../src/console/pages/core/Overview.js");

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

  it("hides a complete checklist behind a Setup complete chip that reopens it", async () => {
    const user = userEvent.setup();
    fns.product.mockResolvedValue({
      product: product({ setup: { secrets: [] } }),
    });
    fns.licenses.mockResolvedValue({
      licenses: [{ id: "l1", status: "active", expiresAt: null }],
    });
    mount();
    await user.click(
      await screen.findByRole("button", { name: "Setup complete" }),
    );
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

  it("shows the signing key in gold with copy, and a quick start using the latest release (OVR-6)", async () => {
    const user = userEvent.setup();
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
    await waitFor(() =>
      expect(document.body.textContent).toContain('version: "2.4.0"'),
    );
    await user.click(screen.getByRole("radio", { name: "Swift" }));
    expect(document.body.textContent).toContain(
      'pinnedKeys: ["djdl-a": "PUBKEY-A"]',
    );
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
