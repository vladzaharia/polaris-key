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
    // Nothing left to do on Integration: the hero's action follows enablement.
    fns.attention.mockResolvedValue({ items: [] });
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
    fns.attention.mockResolvedValue({ items: [] });
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

  it("draws a card for each enabled service in its accent and a dashed cell for the rest", async () => {
    mount();
    const license = await screen.findByRole("heading", {
      level: 3,
      name: "Licensing",
    });
    expect(
      license.closest("[data-service]")?.getAttribute("data-service"),
    ).toBe("license");
    expect(
      screen.getByRole("heading", { level: 3, name: "Managed config" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { level: 3, name: "Releases" }),
    ).toBeNull();
    // Ship builds is off: its dashed cell says so and offers Turn on.
    const off = screen.getByRole("link", { name: "Ship builds: off. Turn on" });
    expect(off.closest("article")?.getAttribute("data-feature")).toBe("off");
    expect(await screen.findByText(/2 settings/)).toBeTruthy();
    expect(await screen.findByText(/7 devices/)).toBeTruthy();
  });

  it("M7: Ship builds is one tile with its lines inside and no accent top rule", async () => {
    fns.product.mockResolvedValue({
      product: product({
        services: enablement(["release", "distribution", "update"]),
      }),
    });
    mount();
    const ship = (
      await screen.findByRole("heading", { level: 3, name: "Ship builds" })
    ).closest("article")!;
    for (const name of ["Releases", "Rollouts", "In-app updates"])
      expect(screen.queryByRole("heading", { level: 3, name })).toBeNull();
    expect(ship.className).not.toContain("border-t-accent");
    expect(await within(ship).findByText(/rollouts live/)).toBeTruthy();
    expect(await within(ship).findByText(/In-app updates:/)).toBeTruthy();
  });

  it("B-051: Ship builds' three services share the Releases accent, in the card too", async () => {
    const { tileAccent, FeatureCard } =
      await import("../src/console/sections/core/components/TileFrame.js");
    expect(
      ["release", "distribution", "update"].map((x) => tileAccent(x as never)),
    ).toEqual(["release", "release", "release"]);
    expect(tileAccent("license")).toBe("license");
    expect(tileAccent("config")).toBe("config");
    const { container } = renderAt(
      "#/p/djdl",
      <FeatureCard service="update" href="#/x" foot="x" />,
    );
    expect(
      container.querySelector("article")?.getAttribute("data-service"),
    ).toBe("release");
  });

  it("B-052/B-060: Open Activity is a 24 px target and the minted-token step reads as an instruction", async () => {
    mount();
    const activity = await screen.findByRole("link", { name: /Open Activity/ });
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
      await screen.findByRole("heading", { level: 3, name: "Commerce" }),
    ).toBeTruthy();
    expect(screen.getByText(/Runs 2 features/)).toBeTruthy();
  });

  it("puts Integration in the hero (a gauge per platform) and the steps on a rail", async () => {
    mount();
    const pane = (await screen.findByTestId("integration-pane")) as HTMLElement;
    expect(
      within(pane)
        .getByRole("link", { name: "Integration" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/integration");
    expect(await within(pane).findByText("1 of 2 verified")).toBeTruthy();
    expect(within(pane).getByText("macOS")).toBeTruthy();
    expect(within(pane).getByText(/Last seen/)).toBeTruthy();
    expect(within(pane).getByText(/Swift SDK 1.2.3/)).toBeTruthy();
    const steps = screen.getByRole("list", { name: "Integration steps" });
    const rows = within(steps).getAllByRole("listitem");
    expect(rows.map((x) => x.getAttribute("data-step"))).toEqual([
      "done",
      "current",
    ]);
    // Licensing is done: a tick and no sub-line; Managed config is the current step.
    expect(within(rows[0]!).getByText(", done")).toBeTruthy();
    expect(
      within(rows[1]!).getByRole("link", { name: "Publish a catalog" }),
    ).toBeTruthy();
    expect(
      within(rows[0]!)
        .getByRole("img", { name: /^macOS: Verified .+/ })
        .getAttribute("data-state"),
    ).toBe("verified");
    expect(
      within(rows[1]!)
        .getByRole("img", { name: "macOS: After the console step" })
        .getAttribute("data-state"),
    ).toBe("after");
    expect(screen.queryByRole("heading", { name: "Setup" })).toBeNull();
    expect(screen.queryByText("Trust & SDK")).toBeNull();
    expect(screen.queryByTestId("product-welcome")).toBeNull();
  });

  it("offers the drop-in kit once, on the first feature waiting on the app", async () => {
    const waiting = (
      id: "identity" | "sync",
      service: "identity" | "sync",
    ) => ({
      id,
      service,
      prerequisites: [],
      unavailable: false,
      facts: {},
      status: "not_seen" as const,
      verifiedOn: [],
    });
    const base = integrationView();
    fns.integration.mockResolvedValue(
      integrationView({
        features: [
          base.features[0]!,
          waiting("identity", "identity"),
          waiting("sync", "sync"),
        ],
      }),
    );
    fns.attention.mockResolvedValue({ items: [] });
    mount();
    expect(
      await screen.findByRole("link", { name: "Sign-in drop-in kit" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", {
        name: "Integrate Sign-in directly with your own UI: Swift SDK docs",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "Cloud Sync drop-in kit" }),
    ).toBeNull();
    expect(
      screen.getByRole("img", { name: "macOS: Waiting for the first sync" }),
    ).toBeTruthy();
  });

  it("the hero states the first attention item, the warning edge and +N more", async () => {
    mount();
    const hero = (await screen.findByTestId("overview-hero")) as HTMLElement;
    await within(hero).findByText(/has no value in the Default profile/);
    expect(hero.hasAttribute("data-issue")).toBe(true);
    expect(hero.querySelector("[data-edge]")).toBeTruthy();
    expect(within(hero).getByText("Warning")).toBeTruthy();
    expect(within(hero).getByRole("link", { name: "Open keys" })).toBeTruthy();
    expect(within(hero).getByRole("link", { name: /\+1 more/ })).toBeTruthy();
    // The problem is said once: Needs attention is not a card of its own.
    expect(
      screen.queryByRole("heading", { name: "Needs attention" }),
    ).toBeNull();
  });

  it("with nothing to fix, the computed next step is the hero's one action", async () => {
    fns.attention.mockResolvedValue({ items: [] });
    mount();
    const hero = (await screen.findByTestId("overview-hero")) as HTMLElement;
    expect(
      (
        await within(hero).findByRole("link", { name: "Publish a catalog" })
      ).getAttribute("href"),
    ).toBe("#/p/djdl/config/catalog");
    expect(hero.hasAttribute("data-issue")).toBe(false);
    expect(
      within(hero).getByText(
        /needs a published catalog before an app can use it/,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "New license" })).toBeNull();
  });

  it("Hide is offered once a feature is Verified and records the operator's choice", async () => {
    const user = userEvent.setup();
    fns.productSettings.mockResolvedValue({
      settings: [
        {
          key: "core.setup",
          version: 1,
          value: {
            integrationHidden: null,
            notUsing: [],
            runnerConsent: null,
            skipped: [],
          },
        },
      ],
    });
    fns.updateProductSetting.mockResolvedValue({
      ok: true,
      claimed: false,
      setting: {
        key: "core.setup",
        version: 2,
        value: { integrationHidden: { at: NOW, by: "a@b.c" } },
      },
    });
    mount();
    await user.click(
      await screen.findByRole("button", { name: "Hide Integration" }),
    );
    await waitFor(() => expect(fns.updateProductSetting).toHaveBeenCalled());
    const body = fns.updateProductSetting.mock.calls[0]![2] as {
      value: { integrationHidden: unknown };
    };
    expect(body.value.integrationHidden).not.toBeNull();
  });

  it("a hidden Integration reopens from the More menu, and its pane and steps are gone", async () => {
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
    await user.click(await screen.findByRole("button", { name: "More" }));
    const show = await screen.findByRole("menuitem", {
      name: /Show Integration/,
    });
    expect(screen.queryByTestId("integration-pane")).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Integration steps" }),
    ).toBeNull();
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
    expect(screen.queryByTestId("integration-pane")).toBeNull();
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
    expect(
      await screen.findByText(/has no value in the Default profile/),
    ).toBeTruthy();
    expect(screen.queryByText("What needs attention didn't load.")).toBeNull();
  });

  it("states licenses expiring soon as the hero's step", async () => {
    fns.attention.mockResolvedValue({ items: [] });
    fns.licenses.mockResolvedValue({
      licenses: [{ id: "l1", status: "active", expiresAt: NOW + 3 * 86400 }],
    });
    mount();
    expect(
      await screen.findByText("1 license expires within 14 days."),
    ).toBeTruthy();
  });

  it("shows an error state with Retry when the product cannot load", async () => {
    const user = userEvent.setup();
    fns.product.mockRejectedValueOnce(new ApiError(500));
    mount();
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "DJDL" }),
    ).toBeTruthy();
  });

  it("a failing tile shows its own error and leaves the page standing", async () => {
    fns.schema.mockRejectedValue(new Error("boom"));
    mount();
    const config = await screen.findByRole("heading", {
      level: 3,
      name: "Managed config",
    });
    const tile = config.closest("article")!;
    expect(
      await within(tile as HTMLElement).findByRole("button", {
        name: "Try again",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 1, name: "DJDL" }),
    ).toBeTruthy();
  });

  it("passes axe", async () => {
    const { container } = mount();
    await screen.findByText(/2 settings/);
    await expectNoAxeViolations(container);
  });
});
