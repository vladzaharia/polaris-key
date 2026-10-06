import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProductDetail, ServiceSlug } from "../src/api.js";
import { renderAt, resetCore } from "./coreTestUtils.js";

/**
 * The console's moments and counters (EXPERIENCE.md §0.7; notes/S-23 §6.1, §6.4; MO-11):
 *
 *   - each moment shows once per product: a stored key, never a per-mount flag; a refetch never
 *     hides or replays it, a remount and a later visit never show it again;
 *   - "first" must be new: a milestone the console could not see happen (a product older than the
 *     feature) is recorded silently, never celebrated late, and an old "before" sighting expires;
 *   - the attention lists on Overview and Home stagger in on the page's first load only: never on
 *     a refetch, a list that mounts later, a remount, a return visit, inside a View Transition or
 *     after "Show all" (whose items apply at once); the class leaves when the items' animations
 *     end, at once under reduced motion;
 *   - Keys: the trust window's ring is aria-hidden and started where the window stands, the seconds
 *     stay in text; the refreshed share fills a meter and counts up the first time only;
 *   - under reduced motion every one of these reaches the same end state, instantly.
 */

const fns = vi.hoisted(() => ({
  product: vi.fn(),
  products: vi.fn(),
  me: vi.fn(),
  summary: vi.fn(),
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
  productSecrets: vi.fn(),
  ciPublisher: vi.fn(),
  ciTokens: vi.fn(),
  storefronts: vi.fn(),
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
const { KeysPage, forgetFilledRefreshLines } =
  await import("../src/console/pages/core/Keys.js");
const { Home } = await import("../src/console/pages/global/Home.js");
const { forgetFirstLoads } =
  await import("../src/console/templates/Dashboard.js");
const { RECENT_SECONDS } = await import("../src/console/components/Moment.js");
const { queryClient } = await import("../src/console/data/queryClient.js");

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const ALL: ServiceSlug[] = [
  "license",
  "config",
  "release",
  "distribution",
  "update",
  "identity",
  "sync",
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
    setup: { secrets: [], warnings: [] },
    ...over,
  };
}

function release(over: Record<string, unknown> = {}) {
  return {
    releaseId: "r1",
    version: "0.1.0",
    publishedAt: NOW - 120,
    deliverable: "app",
    yank: null,
    channel: "stable",
    signer: { kind: "release", kid: "djdl-ci-2026", recordSha256: "ab" },
    ...over,
  };
}

/** The test's own localStorage view of a moment. */
const seen = (key: string): boolean =>
  window.localStorage.getItem(`pk-moment:${key}`) !== null;
const banner = (key: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-moment="${key}"]`);

const overview = () => renderAt("#/p/djdl", <OverviewPage slug="djdl" />);
const keysPage = () => renderAt("#/p/djdl/keys", <KeysPage slug="djdl" />);
const home = () => renderAt("#/", <Home />);

const attentionList = (): HTMLElement =>
  within(screen.getByRole("region", { name: "Needs attention" })).getByRole(
    "list",
  );

/** Remount the page in the same document: the query cache and localStorage survive. */
function remount(mount: () => unknown): void {
  cleanup();
  mount();
}

/** Refetch everything the page reads, as a window refocus would. */
async function refetch(): Promise<void> {
  await act(async () => {
    await queryClient.invalidateQueries();
  });
}

beforeEach(() => {
  resetCore();
  window.localStorage.clear();
  forgetFirstLoads();
  forgetFilledRefreshLines();
  delete document.documentElement.dataset.motion;
  document.documentElement.removeAttribute("data-vt");
  for (const f of Object.values(fns)) f.mockReset();
  fns.product.mockResolvedValue({ product: product() });
  fns.licenses.mockResolvedValue({ licenses: [{ id: "l1" }] });
  fns.productDeviceSummary.mockResolvedValue({
    total: 0,
    byStatus: [],
    licensed: { licensed: 0, licenseFree: 0 },
    byPlatform: [],
    byArch: [],
    bySdkName: [],
    byAppVersion: [],
  });
  fns.schema.mockResolvedValue({ schemaVersion: 1, entries: [{ key: "a" }] });
  fns.profiles.mockResolvedValue({ profiles: [] });
  fns.releases.mockResolvedValue({ releases: [], channels: [], floors: [] });
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
    settings: { portalEnabled: false, oidcEnabled: false, magicEnabled: false },
  });
  fns.activity.mockResolvedValue({ items: [], nextCursor: null });
  fns.productKeys.mockResolvedValue({ keys: [], now: NOW });
  fns.productSecrets.mockResolvedValue({ secrets: [] });
  fns.ciPublisher.mockResolvedValue({ publisher: null });
  fns.ciTokens.mockResolvedValue({ tokens: [] });
  fns.storefronts.mockResolvedValue({ stores: [] });
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.motion;
  document.documentElement.removeAttribute("data-vt");
});

// ── Moments ──────────────────────────────────────────────────────────────────────────────────────

describe("moments show once per product (EXPERIENCE §0.7)", () => {
  beforeEach(() => {
    fns.product.mockResolvedValue({
      product: product({ services: enablement(["license", "release"]) }),
    });
    fns.releases.mockResolvedValue({
      releases: [release()],
      channels: [{ channel: "stable", releaseId: "r1" }],
      floors: [],
    });
  });

  it("the first release lands with one banner, its check and sparks, and a stored key", async () => {
    // The sparks stay while their animations run (jsdom has none, so give them one that runs).
    const proto = HTMLElement.prototype as unknown as {
      getAnimations?: () => unknown[];
    };
    proto.getAnimations = () => [
      { effect: null, finished: new Promise(() => undefined) },
    ];
    onTestFinished(() => {
      delete proto.getAnimations;
    });
    overview();
    const title = await screen.findByText("0.1.0 is live on stable");
    const card = banner("first-release:djdl")!;
    expect(card.contains(title)).toBe(true);
    expect(within(card).getByText(/Your first release/)).toBeTruthy();
    expect(within(card).getByText("djdl-ci-2026")).toBeTruthy();
    // The success pattern: the check draws and the sparks burst, all aria-hidden.
    const celebration = card.querySelector(".pk-celebration")!;
    expect(celebration.getAttribute("aria-hidden")).toBe("true");
    expect(celebration.hasAttribute("data-celebrate")).toBe(true);
    expect(card.querySelectorAll(".pk-burst > i")).toHaveLength(6);
    // Never the Polaris mark, never a pill.
    expect(card.querySelector("[data-pk-mark], .pk-pill")).toBeNull();
    expect(seen("first-release:djdl")).toBe(true);
    // Its one next step: Release alone links the release itself.
    expect(
      within(card).getByRole("link", { name: /View release/ }),
    ).toBeTruthy();
  });

  it("a refetch neither hides nor replays it; a remount and a later visit never show it again", async () => {
    overview();
    await screen.findByText("0.1.0 is live on stable");
    const celebration =
      banner("first-release:djdl")!.querySelector(".pk-celebration");
    await refetch();
    expect(banner("first-release:djdl")).not.toBeNull();
    // The same element: nothing remounted, so nothing restarted.
    expect(banner("first-release:djdl")!.querySelector(".pk-celebration")).toBe(
      celebration,
    );
    remount(overview);
    await screen.findByRole("heading", { level: 1, name: "DJDL" });
    await waitFor(() => expect(fns.releases).toHaveBeenCalled());
    await act(async () => undefined);
    expect(banner("first-release:djdl")).toBeNull();
    expect(screen.queryByText("0.1.0 is live on stable")).toBeNull();
  });

  it("is per product: another product's first release still has its own", async () => {
    window.localStorage.setItem("pk-moment:first-release:other", "1");
    overview();
    expect(await screen.findByText("0.1.0 is live on stable")).toBeTruthy();
  });

  it("Dismiss hides it for the visit; it stays recorded", async () => {
    overview();
    await screen.findByText("0.1.0 is live on stable");
    await userEvent.click(
      within(banner("first-release:djdl")!).getByRole("button", {
        name: "Dismiss",
      }),
    );
    expect(banner("first-release:djdl")).toBeNull();
    expect(seen("first-release:djdl")).toBe(true);
  });

  it("a release the console could not see land is recorded silently, never celebrated late", async () => {
    fns.releases.mockResolvedValue({
      releases: [release({ publishedAt: NOW - 30 * DAY })],
      channels: [],
      floors: [],
    });
    overview();
    await screen.findByRole("heading", { level: 2, name: "Release" });
    await waitFor(() => expect(seen("first-release:djdl")).toBe(true));
    expect(banner("first-release:djdl")).toBeNull();
    // Later releases never bring it back.
    fns.releases.mockResolvedValue({
      releases: [release({ releaseId: "r2", version: "0.2.0" })],
      channels: [],
      floors: [],
    });
    await refetch();
    expect(banner("first-release:djdl")).toBeNull();
  });

  it("a milestone that happens while the page is open shows there and then", async () => {
    fns.releases.mockResolvedValue({ releases: [], channels: [], floors: [] });
    overview();
    await screen.findByText("No releases");
    expect(
      window.localStorage.getItem("pk-moment-before:first-release:djdl"),
    ).not.toBeNull();
    fns.releases.mockResolvedValue({
      releases: [release({ publishedAt: NOW })],
      channels: [],
      floors: [],
    });
    await refetch();
    expect(await screen.findByText("0.1.0 is live on stable")).toBeTruthy();
  });

  it("yanked releases are not a first release", async () => {
    fns.releases.mockResolvedValue({
      releases: [release({ yank: { reason: "bad", at: NOW, by: "admin:x" } })],
      channels: [],
      floors: [],
    });
    overview();
    await screen.findByRole("heading", { level: 2, name: "Release" });
    await act(async () => undefined);
    expect(banner("first-release:djdl")).toBeNull();
    expect(seen("first-release:djdl")).toBe(false);
  });
});

describe("moments with no time of their own count when the console saw the product before", () => {
  it("first catalog publish: 'not yet' (a 404) is remembered, then the publish is celebrated", async () => {
    fns.product.mockResolvedValue({
      product: product({ services: enablement(["config"]) }),
    });
    fns.schema.mockRejectedValue(new ApiError(404));
    overview();
    await screen.findByText("No catalog yet");
    await waitFor(() =>
      expect(
        window.localStorage.getItem("pk-moment-before:first-catalog:djdl"),
      ).not.toBeNull(),
    );
    // A later visit, after the catalog was published elsewhere.
    fns.schema.mockResolvedValue({
      schemaVersion: 1,
      entries: [{ key: "a" }],
    });
    remount(overview);
    await refetch();
    const title = await screen.findByText("Catalog v1 is live");
    expect(banner("first-catalog:djdl")!.contains(title)).toBe(true);
    expect(
      screen.getByText("Your app reads it on its next launch."),
    ).toBeTruthy();
    expect(seen("first-catalog:djdl")).toBe(true);
    // The "before" sighting is spent once the moment is shown.
    expect(
      window.localStorage.getItem("pk-moment-before:first-catalog:djdl"),
    ).toBeNull();
  });

  it("a sighting older than a week no longer counts: recorded silently instead", async () => {
    fns.product.mockResolvedValue({
      product: product({ services: enablement(["config"]) }),
    });
    window.localStorage.setItem(
      "pk-moment-before:first-catalog:djdl",
      String(NOW - RECENT_SECONDS - DAY),
    );
    overview();
    await screen.findByText("1 keys");
    await waitFor(() => expect(seen("first-catalog:djdl")).toBe(true));
    expect(banner("first-catalog:djdl")).toBeNull();
  });

  it("a catalog that failed to load decides nothing", async () => {
    fns.product.mockResolvedValue({
      product: product({ services: enablement(["config"]) }),
    });
    fns.schema.mockRejectedValue(new ApiError(500));
    overview();
    await screen.findByRole("heading", { level: 2, name: "Config" });
    await waitFor(() => expect(fns.schema).toHaveBeenCalled());
    await act(async () => undefined);
    expect(
      window.localStorage.getItem("pk-moment-before:first-catalog:djdl"),
    ).toBeNull();
    expect(seen("first-catalog:djdl")).toBe(false);
  });

  it("store connected: the first connected storefront, once", async () => {
    fns.product.mockResolvedValue({
      product: product({ services: enablement(["distribution"]) }),
    });
    window.localStorage.setItem(
      "pk-moment-before:store-connected:djdl",
      String(NOW - 60),
    );
    fns.storefronts.mockResolvedValue({
      stores: [
        { id: "steam", label: "Steam", connection: { state: "keyless" } },
        { id: "itch", label: "itch.io", connection: { state: "connected" } },
      ],
    });
    overview();
    expect(await screen.findByText("itch.io is connected")).toBeTruthy();
    expect(
      within(banner("store-connected:djdl")!).getByRole("link", {
        name: /Storefronts/,
      }),
    ).toBeTruthy();
  });

  it("product launched: the setup checklist finishing is one '<Product> is launched' line", async () => {
    fns.product.mockResolvedValue({
      product: product({
        setup: {
          secrets: [{ name: "HOOK", configured: false, sources: ["Webhook"] }],
          warnings: [],
        },
      }),
    });
    overview();
    await screen.findByText("Set secret HOOK");
    await waitFor(() =>
      expect(
        window.localStorage.getItem("pk-moment-before:product-launched:djdl"),
      ).not.toBeNull(),
    );
    fns.product.mockResolvedValue({
      product: product({
        setup: {
          secrets: [{ name: "HOOK", configured: true, sources: ["Webhook"] }],
          warnings: [],
        },
      }),
    });
    await refetch();
    expect(await screen.findByText("DJDL is launched")).toBeTruthy();
    expect(seen("product-launched:djdl")).toBe(true);
  });

  it("an already-launched product is recorded, not celebrated", async () => {
    overview();
    await screen.findByRole("heading", { level: 1, name: "DJDL" });
    await waitFor(() => expect(seen("product-launched:djdl")).toBe(true));
    expect(screen.queryByText("DJDL is launched")).toBeNull();
  });

  it("while a list the checklist reads is loading, launched is not judged", async () => {
    fns.licenses.mockReturnValue(new Promise(() => undefined));
    overview();
    await screen.findByRole("heading", { level: 1, name: "DJDL" });
    await act(async () => undefined);
    expect(seen("product-launched:djdl")).toBe(false);
    expect(
      window.localStorage.getItem("pk-moment-before:product-launched:djdl"),
    ).toBeNull();
  });
});

describe("moments read defensively", () => {
  it("a storefronts answer without its list decides nothing and breaks nothing", async () => {
    fns.product.mockResolvedValue({
      product: product({
        services: enablement(["license", "release", "distribution"]),
      }),
    });
    fns.releases.mockResolvedValue({
      releases: [release({ channel: null })],
      channels: [],
      floors: [],
    });
    // An answer without its list (a scripted or older backend answering `{}`).
    fns.storefronts.mockResolvedValue({});
    overview();
    expect(await screen.findByText("0.1.0 is live")).toBeTruthy();
    expect(seen("store-connected:djdl")).toBe(false);
    expect(
      window.localStorage.getItem("pk-moment-before:store-connected:djdl"),
    ).toBeNull();
  });
});

describe("moments under reduced motion: the same line, a static check", () => {
  for (const how of ["data-motion", "media"] as const) {
    it(`(${how}) shows the banner with no burst`, async () => {
      if (how === "data-motion")
        document.documentElement.dataset.motion = "reduce";
      else
        vi.stubGlobal("matchMedia", (q: string) => ({
          matches: q.includes("reduce"),
          media: q,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }));
      fns.product.mockResolvedValue({
        product: product({ services: enablement(["release"]) }),
      });
      fns.releases.mockResolvedValue({
        releases: [release()],
        channels: [],
        floors: [],
      });
      overview();
      await screen.findByText("0.1.0 is live on stable");
      const card = banner("first-release:djdl")!;
      expect(
        card.querySelector(".pk-celebration")!.hasAttribute("data-static"),
      ).toBe(true);
      expect(card.querySelector(".pk-burst")).toBeNull();
      expect(seen("first-release:djdl")).toBe(true);
      vi.unstubAllGlobals();
    });
  }
});

// ── Attention-list stagger ──────────────────────────────────────────────────────────────────────

const warned = () =>
  product({
    setup: {
      secrets: [],
      warnings: ["Webhook URL is unreachable", "release: Missing workflow"],
    },
  });

describe("Overview's attention list staggers in on the page's first load only", () => {
  beforeEach(() => {
    fns.product.mockResolvedValue({ product: warned() });
  });

  it("staggers when the product arrives while the page is open", async () => {
    overview();
    await screen.findByRole("region", { name: "Needs attention" });
    expect(attentionList().className).toMatch(/\bpk-stagger\b/);
  });

  it("staggers on the page's first visit even when the product is already cached", async () => {
    // Overview gets its product at once from the products list (a placeholder): still its first load.
    queryClient.setQueryData(["product", "djdl"], warned());
    overview();
    await screen.findByRole("region", { name: "Needs attention" });
    expect(attentionList().className).toMatch(/\bpk-stagger\b/);
  });

  it("a refetch keeps the same items (nothing restarts) and a remount does not stagger", async () => {
    overview();
    await screen.findByRole("region", { name: "Needs attention" });
    const items = within(attentionList()).getAllByRole("listitem");
    await refetch();
    expect(within(attentionList()).getAllByRole("listitem")).toEqual(items);
    remount(overview);
    await screen.findByRole("region", { name: "Needs attention" });
    expect(attentionList().className).not.toMatch(/\bpk-stagger\b/);
  });

  it("a return visit with the product on the way again does not stagger", async () => {
    overview();
    await screen.findByRole("region", { name: "Needs attention" });
    cleanup();
    queryClient.clear();
    overview();
    await screen.findByRole("region", { name: "Needs attention" });
    expect(attentionList().className).not.toMatch(/\bpk-stagger\b/);
  });

  it("a list a refetch mounts later is not part of the first load", async () => {
    fns.product.mockResolvedValue({ product: product() });
    overview();
    await screen.findByRole("heading", { level: 1, name: "DJDL" });
    expect(
      screen.queryByRole("region", { name: "Needs attention" }),
    ).toBeNull();
    fns.product.mockResolvedValue({ product: warned() });
    await refetch();
    await screen.findByRole("region", { name: "Needs attention" });
    expect(attentionList().className).not.toMatch(/\bpk-stagger\b/);
  });

  it("never inside a View Transition", async () => {
    let arrive!: (v: unknown) => void;
    fns.product.mockReturnValue(new Promise((r) => (arrive = r)));
    overview();
    document.documentElement.setAttribute("data-vt", "route");
    await act(async () => arrive({ product: warned() }));
    await screen.findByRole("region", { name: "Needs attention" });
    expect(attentionList().className).not.toMatch(/\bpk-stagger\b/);
  });

  it("Show all turns it off for good, and the extra items apply at once", async () => {
    fns.product.mockResolvedValue({
      product: product({
        setup: {
          secrets: [],
          warnings: ["w1", "w2", "w3", "w4", "w5", "w6", "w7"],
        },
      }),
    });
    overview();
    await screen.findByRole("region", { name: "Needs attention" });
    expect(attentionList().className).toMatch(/\bpk-stagger\b/);
    await userEvent.click(screen.getByRole("button", { name: "Show all 7" }));
    expect(within(attentionList()).getAllByRole("listitem")).toHaveLength(7);
    expect(attentionList().className).not.toMatch(/\bpk-stagger\b/);
    await userEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(attentionList().className).not.toMatch(/\bpk-stagger\b/);
  });
});

describe("the stagger class leaves when the items' animations end (never on a timer)", () => {
  const proto = HTMLElement.prototype as unknown as {
    getAnimations?: (o?: unknown) => unknown[];
  };
  afterEach(() => {
    delete proto.getAnimations;
  });

  it("waits on the items' own animations", async () => {
    let finish!: () => void;
    const finished = new Promise<void>((r) => (finish = r));
    proto.getAnimations = function (this: HTMLElement) {
      return [...this.children].map((li) => ({
        effect: { target: li },
        finished,
      }));
    };
    fns.product.mockResolvedValue({ product: warned() });
    overview();
    await screen.findByRole("region", { name: "Needs attention" });
    expect(attentionList().className).toMatch(/\bpk-stagger\b/);
    await act(async () => finish());
    await waitFor(() =>
      expect(attentionList().className).not.toMatch(/\bpk-stagger\b/),
    );
  });

  it("under reduced motion there are none, so it comes off at once", async () => {
    document.documentElement.dataset.motion = "reduce";
    proto.getAnimations = () => [];
    fns.product.mockResolvedValue({ product: warned() });
    overview();
    await screen.findByRole("region", { name: "Needs attention" });
    await waitFor(() =>
      expect(attentionList().className).not.toMatch(/\bpk-stagger\b/),
    );
    // The same items, all there: the end state is the same.
    expect(within(attentionList()).getAllByRole("listitem")).toHaveLength(2);
  });
});

describe("Home's attention list staggers in on Home's first load only", () => {
  beforeEach(() => {
    const row = {
      ...product({ slug: "acme", name: "Acme" }),
      setup: {
        healthy: false,
        secrets: [
          { name: "OIDC_CLIENT_SECRET", configured: false, sources: ["OIDC"] },
        ],
      },
    };
    fns.products.mockResolvedValue({ products: [row] });
    fns.me.mockResolvedValue({
      sub: "u",
      email: "u@x.io",
      platformAdmin: true,
      products: [],
    });
    fns.summary.mockResolvedValue({ products: {} });
  });

  it("staggers when the products arrive, and not on a return visit", async () => {
    home();
    await screen.findByRole("region", { name: "Needs attention" });
    expect(attentionList().className).toMatch(/\bpk-stagger\b/);
    // The product cards do not stagger.
    expect(
      screen.getByRole("list", { name: "Products" }).className,
    ).not.toMatch(/\bpk-stagger\b/);
    remount(home);
    await screen.findByRole("region", { name: "Needs attention" });
    expect(attentionList().className).not.toMatch(/\bpk-stagger\b/);
  });

  it("a refetch that turns an empty Home into one with attention does not stagger", async () => {
    fns.products.mockResolvedValue({ products: [] });
    home();
    await screen.findByText("Register your first product");
    fns.products.mockResolvedValue({
      products: [
        {
          ...product({ slug: "acme", name: "Acme" }),
          setup: {
            healthy: false,
            secrets: [{ name: "S", configured: false, sources: ["S"] }],
          },
        },
      ],
    });
    await refetch();
    await screen.findByRole("region", { name: "Needs attention" });
    expect(attentionList().className).not.toMatch(/\bpk-stagger\b/);
  });
});

// ── Keys: the countdown ring and the refreshed meter ────────────────────────────────────────────

function stagedKeys(now = NOW) {
  return {
    now,
    keys: [
      {
        kid: "djdl-a",
        status: "active",
        alg: "Ed25519",
        publicKey: "PUB-A",
        createdAt: now - 1000,
        activateAfter: null,
        activatedAt: now - 1000,
        retiredAt: null,
        revokedAt: null,
      },
      {
        kid: "djdl-b",
        status: "staged",
        alg: "Ed25519",
        publicKey: "PUB-B",
        createdAt: now - 60,
        activateAfter: now + 240,
        activatedAt: null,
        retiredAt: null,
        revokedAt: null,
      },
    ],
  };
}

const ms = (v: string): number => parseFloat(v);

describe("Keys: the trust window as a ring beside its countdown", () => {
  it("is aria-hidden, the seconds stay in text, and it starts where the window stands", async () => {
    fns.productKeys.mockResolvedValue(stagedKeys());
    keysPage();
    const strip = await screen.findByRole("list", { name: "Key rotation" });
    const step = within(strip).getAllByRole("listitem")[1]!;
    expect(within(step).getByText("4:00")).toBeTruthy();
    const svg = step.querySelector("[data-countdown-ring]")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    const ring = svg.querySelector<SVGGElement>(".pk-countdown")!;
    // The whole window (300 s), 60 s of it already spent: through the CSSOM, never markup.
    expect(ring.style.getPropertyValue("--pk-countdown")).toBe("300000ms");
    expect(
      ms(ring.style.getPropertyValue("--pk-countdown-elapsed")),
    ).toBeGreaterThanOrEqual(60_000);
    expect(
      ms(ring.style.getPropertyValue("--pk-countdown-elapsed")),
    ).toBeLessThan(62_000);
    expect(ring.getAttribute("style") ?? "").not.toMatch(
      /animation|transition/,
    );
    // The still picture matches the text: a fifth of the window is spent.
    expect(
      Math.round(ms(ring.style.getPropertyValue("--pk-countdown-spent"))),
    ).toBe(20);
  });

  it("with motion off the text is still accurate and the ring shows the same share", async () => {
    document.documentElement.dataset.motion = "reduce";
    fns.productKeys.mockResolvedValue(stagedKeys());
    keysPage();
    const strip = await screen.findByRole("list", { name: "Key rotation" });
    const step = within(strip).getAllByRole("listitem")[1]!;
    expect(within(step).getByText("4:00")).toBeTruthy();
    const ring = step.querySelector<SVGGElement>(".pk-countdown")!;
    expect(
      Math.round(ms(ring.style.getPropertyValue("--pk-countdown-spent"))),
    ).toBe(20);
  });

  it("follows the seconds: the still picture moves with the tick, the animation is set once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fns.productKeys.mockResolvedValue(stagedKeys());
      keysPage();
      const strip = await screen.findByRole("list", { name: "Key rotation" });
      const step = within(strip).getAllByRole("listitem")[1]!;
      const ring = step.querySelector<SVGGElement>(".pk-countdown")!;
      const elapsed = ring.style.getPropertyValue("--pk-countdown-elapsed");
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      expect(within(step).getByText(/^3:[23]\d$/)).toBeTruthy();
      expect(
        Math.round(ms(ring.style.getPropertyValue("--pk-countdown-spent"))),
      ).toBeGreaterThanOrEqual(29);
      expect(ring.style.getPropertyValue("--pk-countdown-elapsed")).toBe(
        elapsed,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Keys: the refreshed share as a meter that counts up", () => {
  const refreshed = () => ({
    keys: [stagedKeys().keys[0]],
    now: NOW,
    refresh: {
      kid: "djdl-a",
      activatedAt: NOW - 3 * DAY,
      activeDevices: 1310,
      refreshedDevices: 1204,
      windowDays: 30,
    },
  });
  const digits = (): string =>
    document.querySelector("[data-count-up] [aria-hidden='true']")!
      .textContent ?? "";
  const meter = (): HTMLElement =>
    document.querySelector<HTMLElement>(
      "[data-refreshed-meter] .pk-meter-fill",
    )!;

  it("fills to the share through the CSSOM, the sentence said once, and counts up the first time", async () => {
    fns.productKeys.mockResolvedValue(refreshed());
    keysPage();
    expect(
      await screen.findByText(
        "91% of active devices have refreshed since djdl-a went live.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "91% of active devices have refreshed since djdl-a went live.",
      ).className,
    ).toContain("sr-only");
    expect(
      document
        .querySelector("[data-refreshed-meter]")!
        .getAttribute("aria-hidden"),
    ).toBe("true");
    expect(meter().style.getPropertyValue("--pk-meter")).toBe("0.91");
    // It counts from 0 towards 91…
    expect(ms(digits())).toBeLessThan(91);
    await waitFor(() => expect(digits()).toBe("91%"));
  });

  it("a remount shows it at its value: the count does not replay", async () => {
    fns.productKeys.mockResolvedValue(refreshed());
    keysPage();
    await screen.findByText(/91% of active devices/);
    await waitFor(() => expect(digits()).toBe("91%"));
    remount(keysPage);
    await screen.findByText(/91% of active devices/);
    expect(digits()).toBe("91%");
    expect(meter().style.getPropertyValue("--pk-meter")).toBe("0.91");
  });

  it("under reduced motion the number and the meter are at their value from the first paint", async () => {
    document.documentElement.dataset.motion = "reduce";
    fns.productKeys.mockResolvedValue(refreshed());
    keysPage();
    await screen.findByText(/91% of active devices/);
    expect(digits()).toBe("91%");
    expect(meter().style.getPropertyValue("--pk-meter")).toBe("0.91");
  });

  it("with no active device there is no meter and no count, only the sentence", async () => {
    fns.productKeys.mockResolvedValue({
      ...refreshed(),
      refresh: {
        ...refreshed().refresh,
        activeDevices: 0,
        refreshedDevices: 0,
      },
    });
    keysPage();
    await screen.findByText(/No device has been active/);
    expect(document.querySelector("[data-refreshed-meter]")).toBeNull();
    expect(document.querySelector("[data-count-up]")).toBeNull();
  });
});
