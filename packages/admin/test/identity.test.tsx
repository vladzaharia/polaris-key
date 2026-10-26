import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import type {
  EdgeMintIdentity,
  EdgeMintRecipesResponse,
  PortalProductSettings,
  ProductDetail,
  ResyncPlanResult,
  ResyncResult,
  SignInSettings,
  UpdatePortalSettingsBody,
} from "../src/api.js";
import { KitProviders } from "../src/kit/KitProviders.js";
import { AppToaster } from "../src/ui/toast.js";
import { createQueryClient } from "../src/console/data/queryClient.js";
import { qk } from "../src/console/data/queries.js";

const portalSettings =
  vi.fn<(slug: string) => Promise<{ settings: PortalProductSettings }>>();
const updatePortalSettings =
  vi.fn<
    (
      slug: string,
      body: UpdatePortalSettingsBody,
    ) => Promise<{ ok: true; settings: PortalProductSettings }>
  >();
const product = vi.fn<(slug: string) => Promise<{ product: ProductDetail }>>();
const resyncProduct = vi.fn<(slug: string) => Promise<ResyncResult>>();
const planResync = vi.fn<(slug: string) => Promise<ResyncPlanResult>>();
const edgeMintRecipes =
  vi.fn<(slug: string) => Promise<EdgeMintRecipesResponse>>();
const signInSettings =
  vi.fn<(slug: string) => Promise<{ settings: SignInSettings }>>();
const services = vi.fn<(slug: string) => Promise<unknown>>();
const servicesDryRun =
  vi.fn<(slug: string, body: unknown) => Promise<unknown>>();
const updateServices =
  vi.fn<(slug: string, body: unknown) => Promise<unknown>>();
const platformConnections = vi.fn<() => Promise<unknown>>();
const productSettings =
  vi.fn<(slug: string, area?: string) => Promise<unknown>>();
const updateSignInSettings =
  vi.fn<
    (
      slug: string,
      patch: { passthroughName?: string | null },
    ) => Promise<{ ok: true; settings: SignInSettings }>
  >();

vi.mock("../src/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return {
    ...actual,
    api: {
      portalSettings: (slug: string) => portalSettings(slug),
      updatePortalSettings: (slug: string, body: UpdatePortalSettingsBody) =>
        updatePortalSettings(slug, body),
      product: (slug: string) => product(slug),
      resyncProduct: (slug: string) => resyncProduct(slug),
      planResync: (slug: string) => planResync(slug),
      edgeMintRecipes: (slug: string) => edgeMintRecipes(slug),
      signInSettings: (slug: string) => signInSettings(slug),
      services: (slug: string) => services(slug),
      servicesDryRun: (slug: string, body: unknown) =>
        servicesDryRun(slug, body),
      updateServices: (slug: string, body: unknown) =>
        updateServices(slug, body),
      platformConnections: () => platformConnections(),
      productSettings: (slug: string, area?: string) =>
        productSettings(slug, area),
      updateSignInSettings: (
        slug: string,
        patch: { passthroughName?: string | null },
      ) => updateSignInSettings(slug, patch),
    },
  };
});

const { AppSignInPage } =
  await import("../src/console/sections/identity/pages/AppSignIn.js");
const { parseGroupMap } =
  await import("../src/console/sections/identity/model/groups.js");

const axe = configureAxe({
  rules: {
    // jsdom computes no colour; contrast is the brand suite's and the browser's.
    "color-contrast": { enabled: false },
    // A page rendered without the shell has no landmarks around it.
    region: { enabled: false },
  },
});

const PORTAL: PortalProductSettings = {
  portalEnabled: true,
  keyReissueEnabled: false,
  claimByKey: true,
  discoverEnabled: true,
  branding: null,
  modifiedAt: 1_700_000_000,
};

const PRODUCT: ProductDetail = {
  slug: "djdl",
  manifestAuthoritative: { value: false, locked: false },
  name: "DJDL",
  signingKid: "kid-2026",
  releaseSource: "github",
  compatMin: "1.0.0",
  compatMax: "2.0.0",
  defaultMaxOfflineDays: 14,
  defaultDeviceLimit: 3,
  adminGroup: "djdl-admins",
  createdAt: 1_700_000_000,
  modifiedAt: 1_710_000_000,
  services: {
    license: { enabled: true },
    config: { enabled: true },
    release: { enabled: true },
    distribution: { enabled: true },
    update: { enabled: true },
    identity: { enabled: true },
    sync: { enabled: false },
    commerce: { enabled: false },
    connect: { enabled: false },
  },
};

const SIGN_IN: SignInSettings = {
  claimByKey: false,
  passthroughName: null,
  effectiveName: "DJDL",
  appReview48Warning: false,
};

const CUSTOM: EdgeMintIdentity = {
  provider: "custom",
  issuer: "https://id.djdl.example",
  clientId: "djdl-console-client",
  groupRoleMapJson: JSON.stringify({
    "djdl-pro": { role: "member", tier: "pro" },
    "djdl-beta": { role: "tester" },
  }),
};

function mintResponse(
  identity: EdgeMintIdentity | null,
  oidcDefault = false,
): EdgeMintRecipesResponse {
  return {
    registration: "requires-license",
    anonymousEnroll: false,
    oidcDefault,
    publicMint: false,
    licenseEnabled: true,
    identity,
    recipes: [],
  };
}

function wrap(ui: React.ReactElement) {
  return render(
    <KitProviders>
      <div data-service="identity">{ui}</div>
      <AppToaster />
    </KitProviders>,
  );
}

const renderPage = () => wrap(<AppSignInPage slug="djdl" />);
const SERVICES = {
  services: {
    license: { enabled: true },
    config: { enabled: true },
    release: { enabled: true },
    distribution: { enabled: true },
    update: { enabled: true },
    identity: { enabled: true },
    sync: { enabled: false },
    commerce: { enabled: false },
    connect: { enabled: false },
  },
  source: "manifest",
  facts: {},
};
const CONNECTIONS = {
  connections: [
    {
      id: "pocket",
      label: "Pocket ID",
      audience: "customers",
      status: "active",
      domains: [
        { domain: "a.example", verified: true },
        { domain: "b.example", verified: true },
        { domain: "c.example", verified: false },
      ],
    },
    {
      id: "okta",
      label: "Studio Okta",
      audience: "operators",
      status: "active",
      domains: [{ domain: "studio.example", verified: true }],
    },
  ],
  builtIns: [
    { kind: "google", label: "Google", configured: true },
    { kind: "apple", label: "Apple", configured: false },
    { kind: "steam", label: "Steam", configured: true },
  ],
  email: { configured: true },
  turnstile: { enabled: false },
};

function toggle(name: string): HTMLElement {
  return screen.getByRole("switch", { name });
}

function checked(el: HTMLElement): boolean {
  return el.getAttribute("aria-checked") === "true";
}

const saveButton = () =>
  screen.queryByRole("button", { name: /^Save \d+ changes?$/ });

async function axeViolations(container: HTMLElement): Promise<string[]> {
  const results = await axe(container);
  return results.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );
}

beforeEach(() => {
  portalSettings.mockReset();
  updatePortalSettings.mockReset();
  product.mockReset();
  resyncProduct.mockReset();
  planResync.mockReset();
  planResync.mockResolvedValue({
    ok: true,
    dryRun: true,
    slug: "djdl",
    repository: "acme/djdl",
    commit: "abcdef0123456789",
    plan: {
      apply: [
        {
          area: "oidc",
          summary: "Sign-in provider and group map from .pkey/product",
        },
      ],
      skipClaimed: [],
      delete: [],
      conflicts: [],
    },
  });
  edgeMintRecipes.mockReset();
  services.mockReset();
  servicesDryRun.mockReset();
  updateServices.mockReset();
  platformConnections.mockReset();
  productSettings.mockReset();
  services.mockResolvedValue(SERVICES);
  platformConnections.mockResolvedValue(CONNECTIONS);
  productSettings.mockImplementation(async (_slug, area) => ({
    settings:
      area === "identity.signIn"
        ? [
            {
              key: "identity.terms",
              value: { version: "2026-10", url: "https://djdl.example/terms" },
            },
          ]
        : [],
  }));
  portalSettings.mockResolvedValue({ settings: PORTAL });
  updatePortalSettings.mockResolvedValue({ ok: true, settings: PORTAL });
  product.mockResolvedValue({ product: PRODUCT });
  edgeMintRecipes.mockResolvedValue(mintResponse(CUSTOM));
  signInSettings.mockReset();
  updateSignInSettings.mockReset();
  signInSettings.mockResolvedValue({ settings: SIGN_IN });
  updateSignInSettings.mockResolvedValue({ ok: true, settings: SIGN_IN });
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

// ── App sign-in (I-29) ────────────────────────────────────────────────────────────────────────

describe("App sign-in", () => {
  it("is one page with a card per section, in order", async () => {
    renderPage();
    expect(
      await screen.findByRole("heading", { level: 1, name: "App sign-in" }),
    ).toBeTruthy();
    await screen.findByText("Always on");
    // Tier sync and License keys are the settings hub's rows: absent while a product has none.
    const titles = (await screen.findAllByRole("heading", { level: 2 }))
      .map((h) => h.textContent)
      .filter((t) => t !== "Tier sync");
    expect(titles).toEqual([
      "Status",
      "Sign-in methods",
      "Product connection",
      "Terms",
      "License keys",
      "Polaris Locker",
      "Presentation",
    ]);
  });

  it("has no per-product toggles: email and passkeys are always on", async () => {
    renderPage();
    await screen.findByText("Always on");
    for (const old of [
      "OIDC access",
      "Email magic links",
      "License-key claim",
      "Release downloads",
      /link/i,
    ])
      expect(screen.queryByRole("switch", { name: old })).toBeNull();
    expect(portalSettings).toHaveBeenCalledWith("djdl");
  });

  it("derives the shortcuts and counts only customer connections and their verified domains", async () => {
    renderPage();
    expect(await screen.findByText("Pocket ID · 2 domains")).toBeTruthy();
    expect(screen.queryByText(/Studio Okta/)).toBeNull();
    expect(screen.getAllByText("On").length).toBe(2);
    expect(screen.getByText("Not set up")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Connections/ }).getAttribute("href"),
    ).toBe("#/platform/connections");
  });

  it("shows the product's provider, issuer, client and group map", async () => {
    renderPage();
    expect(await screen.findByText("DJDL accounts")).toBeTruthy();
    expect(screen.getByText("https://id.djdl.example")).toBeTruthy();
    const table = await screen.findByRole("table", {
      name: "Groups and tiers",
    });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(
      within(rows[1]!).getByRole("link", { name: "pro" }).getAttribute("href"),
    ).toBe("#/p/djdl/license/tiers/pro");
    expect(within(rows[2]!).getByText("Entitlement only")).toBeTruthy();
    expect(screen.getByText(/is refused \(not entitled\)/)).toBeTruthy();
  });

  it("reads an unset provider as the platform default", async () => {
    edgeMintRecipes.mockResolvedValue(
      mintResponse({
        provider: null,
        issuer: null,
        clientId: null,
        groupRoleMapJson: null,
      }),
    );
    renderPage();
    expect(await screen.findByText("Polaris Locker accounts")).toBeTruthy();
    expect(screen.getByText("The platform issuer")).toBeTruthy();
    expect(screen.getByText("No groups are mapped.")).toBeTruthy();
  });

  it("names the manifest's terms version and links them", async () => {
    renderPage();
    expect(await screen.findByText("2026-10")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /View/ }).getAttribute("href"),
    ).toBe("https://djdl.example/terms");
  });

  it("warns about App Review 4.8 only when the server says so", async () => {
    renderPage();
    await screen.findByText("Always on");
    expect(screen.queryByText("App Review guideline 4.8")).toBeNull();
    cleanup();
    signInSettings.mockResolvedValue({
      settings: { ...SIGN_IN, appReview48Warning: true },
    });
    renderPage();
    expect(await screen.findByText("App Review guideline 4.8")).toBeTruthy();
  });

  it("shows Presentation read-only, with a way to Settings and no App name field", async () => {
    renderPage();
    const link = await screen.findByRole("link", { name: /Edit in Settings/ });
    expect(link.getAttribute("href")).toBe("#/p/djdl/settings/presentation");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("saves the portal switch, listing the change in words", async () => {
    renderPage();
    await waitFor(() =>
      expect(checked(toggle("Show DJDL in customers' libraries"))).toBe(true),
    );
    // The lost-key switch is hidden until the Locker has the reissue action (G7).
    expect(screen.queryByText("Let customers replace a lost key")).toBeNull();
    expect(saveButton()).toBeNull();
    await userEvent.click(toggle("Show DJDL in customers' libraries"));
    expect(screen.getByText(/1 change: DJDL hidden in libraries/)).toBeTruthy();
    expect(screen.getAllByText("Not saved").length).toBeGreaterThan(0);
    await userEvent.click(saveButton()!);
    await waitFor(() => expect(updatePortalSettings).toHaveBeenCalledTimes(1));
    expect(updatePortalSettings.mock.calls[0]).toEqual([
      "djdl",
      { portalEnabled: false },
    ]);
    expect(
      await screen.findByText("Saved 1 change to App sign-in"),
    ).toBeTruthy();
  });

  it("keeps the draft and says why when a save fails", async () => {
    updatePortalSettings.mockRejectedValue(new Error("boom"));
    renderPage();
    await userEvent.click(
      await screen.findByRole("switch", {
        name: "Show DJDL in customers' libraries",
      }),
    );
    await userEvent.click(saveButton()!);
    await waitFor(() => expect(updatePortalSettings).toHaveBeenCalled());
    expect(checked(toggle("Show DJDL in customers' libraries"))).toBe(false);
    expect(saveButton()).toBeTruthy();
  });

  it("turning Sign-in off asks first, naming what else turns off", async () => {
    servicesDryRun.mockResolvedValue({
      changes: [],
      cascaded: ["sync"],
      signedInDevicesToClear: 0,
    });
    updateServices.mockResolvedValue({
      ...SERVICES,
      services: { ...SERVICES.services, identity: { enabled: false } },
    });
    renderPage();
    const status = await screen.findByRole("switch", {
      name: "Sign-in for DJDL",
    });
    await userEvent.click(status);
    const dialog = await screen.findByRole("alertdialog");
    expect(updateServices).not.toHaveBeenCalled();
    expect(checked(status)).toBe(true);
    expect(within(dialog).getByText("Turn off Sign-in for DJDL?")).toBeTruthy();
    expect(within(dialog).getAllByText(/On → Off/)).toHaveLength(2);
    await userEvent.click(
      within(dialog).getByRole("button", { name: /^Turn off Sign-in and/ }),
    );
    await waitFor(() => expect(updateServices).toHaveBeenCalledTimes(1));
    expect(updateServices.mock.calls[0]![1]).toEqual({
      services: { identity: { enabled: false }, sync: { enabled: false } },
    });
    // The switch gets focus back when the dialog closes.
    await waitFor(() => expect(document.activeElement).toBe(status));
  });

  it("renders every card but Product connection when Managed config is out of reach (403)", async () => {
    const { HttpError } = await import("../src/api.js");
    edgeMintRecipes.mockRejectedValue(
      new HttpError(403, { fields: [], code: "forbidden" }),
    );
    renderPage();
    expect(await screen.findByText(/Needs Managed config access/)).toBeTruthy();
    expect(screen.getByText("Always on")).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Sign-in for DJDL" }),
    ).toBeTruthy();
  });

  it("says who sets the methods when the platform is out of reach", async () => {
    platformConnections.mockRejectedValue(new Error("403"));
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText("Set by the platform")).toHaveLength(5),
    );
    expect(screen.queryByText("Unavailable")).toBeNull();
    expect(screen.queryByRole("link", { name: /Connections/ })).toBeNull();
    for (const label of ["Apple", "Google", "Steam"])
      expect(screen.getByText(label)).toBeTruthy();
  });

  it("shows a compact error in Terms when its read fails, never a false 'None'", async () => {
    productSettings.mockImplementation(async (_s, area) => {
      if (area === "identity.signIn") throw new Error("boom");
      return { settings: [] };
    });
    renderPage();
    const terms = (
      await screen.findByRole("heading", { name: "Terms" })
    ).closest("section")!;
    await within(terms).findByRole("button", { name: /try again|retry/i });
    expect(within(terms).queryByText(/None\. Set identity\.terms/)).toBeNull();
  });

  it("shows the key-entry limit as 5 / 10 / 25 / No limit, with the manifest's value after a console change", async () => {
    productSettings.mockImplementation(async (_s, area) => ({
      settings:
        area === "identity.keyEntry"
          ? [
              {
                key: "identity.keyEntry.limit",
                spec: { kind: "integer", unit: "count", min: 1, max: 100 },
                value: 10,
                source: "console",
                manifestValue: 5,
                version: 3,
              },
            ]
          : [],
    }));
    renderPage();
    expect(await screen.findByText(/says\s+5/)).toBeTruthy();
    const group = screen.getByRole("radiogroup", {
      name: "Key entries before an account is needed",
    });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((e) => e.textContent),
    ).toEqual(["5", "10", "25", "No limit"]);
    expect(
      screen.getByRole("button", { name: "Revert to manifest…" }),
    ).toBeTruthy();
  });

  it("shows a loading state, then an error state with a working retry", async () => {
    portalSettings.mockRejectedValueOnce(new Error("boom"));
    renderPage();
    await waitFor(() =>
      expect(document.querySelector('[data-skeleton="form"]')).not.toBeNull(),
    );
    const retry = await screen.findByRole("button", {
      name: /try again|retry/i,
    });
    await userEvent.click(retry);
    expect(await screen.findByText("Always on")).toBeTruthy();
  });

  it("M8: Resync from repo… is off for a member who cannot ship, with the reason, and opens nothing", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(qk.me(), {
      sub: "u2",
      name: "Viewer",
      email: "v@x.io",
      csrf: "c",
      platformAdmin: false,
      products: [{ slug: "djdl", name: "DJDL", schemaVersion: 1 }],
      permissions: {
        roles: [],
        platform: { view: ["console"], edit: [] },
        products: { djdl: { view: ["core", "ship", "signin"], edit: [] } },
      },
    });
    render(
      <KitProviders queryClient={queryClient}>
        <div data-service="identity">
          <AppSignInPage slug="djdl" />
        </div>
      </KitProviders>,
    );
    await screen.findByText("DJDL accounts");
    const trigger = screen.getByRole("button", { name: "Resync from repo…" });
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(trigger);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(resyncProduct).not.toHaveBeenCalled();
  });

  it("confirms a resync (L1, caution) with the plan before running it (IDN-1, UX-78)", async () => {
    resyncProduct.mockResolvedValue({
      ok: true,
      slug: "djdl",
      updated: ["oidc"],
    });
    renderPage();
    await screen.findByText("DJDL accounts");

    const trigger = () =>
      screen.getByRole("button", { name: "Resync from repo…" });
    await waitFor(() => expect(trigger().hasAttribute("disabled")).toBe(false));
    await userEvent.click(trigger());
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Resync DJDL from its repository?"),
    ).toBeTruthy();
    expect(
      await within(dialog).findByText(
        "Sign-in provider and group map from .pkey/product",
      ),
    ).toBeTruthy();
    expect(resyncProduct).not.toHaveBeenCalled();

    // Cancel runs nothing.
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(resyncProduct).not.toHaveBeenCalled();

    await userEvent.click(trigger());
    const again = await screen.findByRole("alertdialog");
    await within(again).findByText(
      "Sign-in provider and group map from .pkey/product",
    );
    await userEvent.click(
      within(again).getByRole("button", { name: "Resync from repo" }),
    );
    await waitFor(() => expect(resyncProduct).toHaveBeenCalledWith("djdl"));
    const panel = await screen.findByTestId("resync-result");
    expect(
      within(panel).getByText("Resynced DJDL from acme/djdl"),
    ).toBeTruthy();
    expect(within(panel).getByText("Updated: sign-in.")).toBeTruthy();
    // The invalidation table: resync → everything under the product (the mint read included).
    await waitFor(() => expect(edgeMintRecipes).toHaveBeenCalledTimes(2));
  });

  it("gates resync on the product actually being linked to a repo", async () => {
    // `release/resync.ts` 422s anything whose `release_source` is not `github`.
    product.mockResolvedValue({
      product: { ...PRODUCT, releaseSource: "manual" },
    });
    renderPage();

    const button = () =>
      screen.getByRole("button", { name: "Resync from repo…" });
    await waitFor(() =>
      expect(button().getAttribute("aria-disabled")).toBe("true"),
    );
    await userEvent.click(button());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(resyncProduct).not.toHaveBeenCalled();
  });

  it("passes axe", async () => {
    const { container } = renderPage();
    await screen.findByRole("table", { name: "Groups and tiers" });
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("parseGroupMap", () => {
  it("reads role and tier grants, bare-string roles, and refuses non-objects", () => {
    expect(parseGroupMap(null)).toEqual([]);
    expect(parseGroupMap("")).toEqual([]);
    expect(parseGroupMap("[]")).toBe("invalid");
    expect(parseGroupMap("{")).toBe("invalid");
    expect(
      parseGroupMap(
        JSON.stringify({ a: { role: "member", tier: "pro" }, b: "admin" }),
      ),
    ).toEqual([
      { group: "a", role: "member", tier: "pro" },
      { group: "b", role: "admin", tier: null },
    ]);
  });
});

describe("App sign-in save summary words", () => {
  it("B-061: the lost-key switch reads as replacement on/off, never shown/hidden", async () => {
    const { lostKeyWords } =
      await import("../src/console/sections/identity/pages/AppSignIn.js");
    expect(lostKeyWords(true)).toBe("lost-key replacement on");
    expect(lostKeyWords(false)).toBe("lost-key replacement off");
  });
});
