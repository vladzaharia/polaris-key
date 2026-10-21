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
  integration: vi.fn(),
  attention: vi.fn(),
  productSettings: vi.fn(),
  updateProductSetting: vi.fn(),
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

const item = (id: string, short: string, lines: string[]) => ({
  id: `djdl:${id}`,
  product: { slug: "djdl", name: "DJDL" },
  kind: id.split(":")[0],
  tone: "warning" as const,
  service: null,
  short,
  lines,
  action: { label: "Open keys", page: "keys" },
  area: "keys",
});
const SECRET_ITEM = item("secret.missing:WEBHOOK_SECRET", "Missing secret", [
  "Required secret `WEBHOOK_SECRET` has no value in the Default profile.",
]);
const SIGNING_ITEM = item("signing.missing", "No signing key", [
  "No usable signing key.",
]);

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
    ...over,
  };
}

export function integrationView(
  over: Partial<import("../src/api.js").IntegrationView> = {},
): import("../src/api.js").IntegrationView {
  return {
    product: "djdl",
    now: NOW,
    snippet: {
      slug: "djdl",
      services: ["license", "config"],
      pins: [{ kid: "djdl-a", publicKey: "PUBKEY-A" }],
      releaseKeys: [],
    },
    features: [
      {
        id: "licensing",
        service: "license",
        prerequisites: [{ id: "tiers", met: true }],
        unavailable: false,
        facts: {},
        status: "verified",
        verifiedOn: [
          {
            sdk: "swift",
            platform: "macos",
            arch: "arm64",
            sdkVersion: "1.2.3",
            lastOkAt: NOW - 60,
          },
        ],
      },
      {
        id: "config",
        service: "config",
        prerequisites: [{ id: "catalog", met: false }],
        unavailable: false,
        facts: {},
        status: "blocked",
        verifiedOn: [],
      },
    ],
    server: [],
    sightings: [
      {
        sdk: "swift",
        platform: "macos",
        arch: "arm64",
        sdkVersion: "1.2.3",
        firstSeenAt: NOW - 600,
        lastSeenAt: NOW - 60,
      },
    ],
    verified: true,
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
    settings: { portalEnabled: true },
  });
  fns.activity.mockResolvedValue({ items: [], nextCursor: null });
  fns.productKeys.mockResolvedValue({
    keys: [
      signingKey("djdl-a", "active", "PUBKEY-A"),
      signingKey("djdl-old", "retired", "PUBKEY-OLD"),
    ],
    now: NOW,
  });
  fns.integration.mockResolvedValue(integrationView());
  fns.attention.mockResolvedValue({ items: [SECRET_ITEM, SIGNING_ITEM] });
  fns.productSettings.mockResolvedValue({ settings: [] });
});
afterEach(cleanup);

describe("Core → Overview", () => {
  it("titles the page with the product and offers New license when License is on (OVR-1)", async () => {
    // Nothing left to do on Integration: the header's primary follows enablement.
    fns.integration.mockResolvedValue(
      integrationView({ features: [], verified: false }),
    );
    mount();
    expect(
      await screen.findByRole("heading", { level: 1, name: "DJDL" }),
    ).toBeTruthy();
    expect(
      (await screen.findByRole("link", { name: "New license" })).getAttribute(
        "href",
      ),
    ).toBe("#/p/djdl/license/licenses?setup=new-license&step=tier");
  });

  it("offers Publish catalog with only Config on, else Enable features", async () => {
    fns.integration.mockResolvedValue(
      integrationView({ features: [], verified: false }),
    );
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
      (await screen.findAllByRole("link", { name: "Enable features" })).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("This product runs no features yet")).toBeTruthy();
  });

  it("draws a tile only for each enabled service, in that service's accent", async () => {
    mount();
    const license = await screen.findByRole("heading", {
      level: 2,
      name: "Licensing",
    });
    expect(
      license.closest("[data-service]")?.getAttribute("data-service"),
    ).toBe("license");
    expect(
      screen.getByRole("heading", { level: 2, name: "Managed config" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { level: 2, name: "Releases" }),
    ).toBeNull();
    expect(await screen.findByText("2 keys")).toBeTruthy();
    expect(await screen.findByText("7 devices")).toBeTruthy();
  });

  it("B-051/B-052: Ship builds' three tiles share the Releases accent and their link is a 24 px target", async () => {
    const { tileAccent, TileFrame } =
      await import("../src/console/sections/core/components/TileFrame.js");
    expect(
      ["release", "distribution", "update"].map((x) => tileAccent(x as never)),
    ).toEqual(["release", "release", "release"]);
    expect(tileAccent("license")).toBe("license");
    expect(tileAccent("config")).toBe("config");
    const { container } = renderAt(
      "#/p/djdl",
      <TileFrame service="update" href="#/x" linkLabel="Open updates" />,
    );
    expect(
      container.querySelector("section")?.getAttribute("data-service"),
    ).toBe("release");
    expect(
      screen.getByRole("link", { name: "Open updates" }).className,
    ).toContain("min-h-6");
  });

  it("B-052/B-060: View activity is a 24 px target and the minted-token step reads as an instruction", async () => {
    mount();
    const activity = await screen.findByRole("link", { name: /View activity/ });
    expect(activity.className).toContain("min-h-6");
    const { nextStep } =
      await import("../src/console/sections/core/model/integration.js");
    expect(
      nextStep("djdl", { features: [] } as never, true, ["edge.mint"])?.reason,
    ).toBe("Approve the recipe before it can mint tokens.");
  });

  it("draws Commerce's tile and counts it among the services the product runs", async () => {
    fns.product.mockResolvedValue({
      product: product({
        services: {
          ...enablement(["license"]),
          commerce: { enabled: true },
        } as Record<ServiceSlug, { enabled: boolean }>,
      }),
    });
    mount();
    expect(
      await screen.findByRole("heading", { level: 2, name: "Commerce" }),
    ).toBeTruthy();
    expect(screen.getByText(/Runs 2 features/)).toBeTruthy();
  });

  it("replaces the checklist, Trust & SDK and the welcome with the Integration card", async () => {
    mount();
    const card = (
      await screen.findByRole("heading", { name: "Integration" })
    ).closest("section")!;
    expect(
      await within(card).findByText(/of 2 features verified/),
    ).toBeTruthy();
    expect(within(card).getByText("Verified")).toBeTruthy();
    expect(within(card).getByText("Waiting on setup")).toBeTruthy();
    expect(within(card).getByText("macOS")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Setup" })).toBeNull();
    expect(screen.queryByText("Trust & SDK")).toBeNull();
    expect(screen.queryByTestId("product-welcome")).toBeNull();
  });

  it("the computed next step is the one primary action", async () => {
    mount();
    expect(
      (
        await screen.findByRole("link", { name: "Publish a catalog" })
      ).getAttribute("href"),
    ).toBe("#/p/djdl/config/catalog");
    expect(screen.queryByRole("link", { name: "Create license" })).toBeNull();
    // It lives in the card, with its reason, and the header carries no second primary.
    const card = screen.getByTestId("integration-card");
    expect(
      within(card).getByText(
        /needs a published catalog before an app can use it/,
      ),
    ).toBeTruthy();
    expect(
      screen.getAllByRole("link", { name: "Publish a catalog" }),
    ).toHaveLength(1);
  });

  it("names an unset secret and a missing signing key under Needs attention (the card hidden, so the next step does not say it)", async () => {
    fns.product.mockResolvedValue({
      product: product({ signing: undefined }),
    });
    fns.productSettings.mockResolvedValue({
      settings: [
        {
          key: "core.setup",
          version: 1,
          value: {
            integrationHidden: { at: NOW, by: "a@b.c" },
            notUsing: [],
            runnerConsent: null,
            skipped: [],
          },
        },
      ],
    });
    mount();
    expect(await screen.findByText("Missing secret")).toBeTruthy();
    expect(await screen.findByText("No signing key")).toBeTruthy();
  });

  it("holds the setup items back until the next step is known (no item rises and is then taken back)", async () => {
    let answer: (v: ReturnType<typeof integrationView>) => void = () => {};
    fns.integration.mockReturnValue(
      new Promise((res) => {
        answer = res;
      }),
    );
    fns.product.mockResolvedValue({
      product: product({ signing: undefined }),
    });
    mount();
    expect(await screen.findByText("Missing secret")).toBeTruthy();
    expect(screen.queryByText("No signing key")).toBeNull();
    answer(integrationView());
    await waitFor(() => expect(screen.getByTestId("integration-card")));
  });

  it("a hidden Integration card is one line that reopens it", async () => {
    const user = userEvent.setup();
    fns.productSettings.mockResolvedValue({
      settings: [
        {
          key: "core.setup",
          version: 1,
          value: {
            integrationHidden: { at: NOW, by: "a@b.c" },
            notUsing: [],
            runnerConsent: null,
            skipped: [],
          },
        },
      ],
    });
    mount();
    const show = await screen.findByRole("button", {
      name: "Show Integration",
    });
    expect(screen.queryByText(/features verified/)).toBeNull();
    fns.updateProductSetting.mockResolvedValue({
      ok: true,
      claimed: false,
      setting: {
        key: "core.setup",
        version: 2,
        value: { integrationHidden: null },
      },
    });
    await user.click(show);
    await waitFor(() => expect(fns.updateProductSetting).toHaveBeenCalled());
    const body = fns.updateProductSetting.mock.calls[0]![2] as {
      value: { integrationHidden: unknown };
      expectedVersion: number;
    };
    expect(body.value.integrationHidden).toBeNull();
    expect(body.expectedVersion).toBe(1);
  });

  it("keeps the page skeleton until the attention read answers, so nothing mounts late", async () => {
    let answer: (v: { items: unknown[] }) => void = () => {};
    fns.attention.mockReturnValue(
      new Promise((res) => {
        answer = res;
      }),
    );
    mount();
    await waitFor(() => expect(fns.product).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByText("Loading overview…")).toBeTruthy();
    expect(screen.queryByTestId("integration-card")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Integration" })).toBeNull();
    answer({ items: [] });
    expect(
      await screen.findByRole("heading", { name: "Integration" }),
    ).toBeTruthy();
  });

  it("says when what needs attention did not load, and tries again", async () => {
    const user = userEvent.setup();
    fns.attention.mockRejectedValue(new Error("boom"));
    mount();
    expect(
      await screen.findByText(
        "What needs attention didn't load.",
        {},
        {
          timeout: 8000,
        },
      ),
    ).toBeTruthy();
    fns.attention.mockResolvedValue({ items: [SECRET_ITEM] });
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Missing secret")).toBeTruthy();
    expect(screen.queryByText("What needs attention didn't load.")).toBeNull();
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
    fns.schema.mockRejectedValue(new Error("boom"));
    mount();
    const config = await screen.findByRole("heading", {
      level: 2,
      name: "Managed config",
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
