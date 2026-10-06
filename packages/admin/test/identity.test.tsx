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
  UpdatePortalSettingsBody,
} from "../src/api.js";
import { resetCache } from "../src/context.js";
import { KitProviders } from "../src/kit/KitProviders.js";
import { AppToaster } from "../src/ui/toast.js";

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
    },
  };
});

const { PortalPage } = await import("../src/console/pages/identity/Portal.js");
const { SignInPage, parseGroupMap } =
  await import("../src/console/pages/identity/SignIn.js");

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
  oidcEnabled: false,
  magicEnabled: true,
  licenseKeyClaimEnabled: false,
  releasesEnabled: true,
  autoLinkEnabled: null,
  keyReissueEnabled: false,
  claimByKey: true,
  discoverEnabled: true,
  branding: null,
  modifiedAt: 1_700_000_000,
};

const PRODUCT: ProductDetail = {
  slug: "djdl",
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
  },
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

const renderPortal = () => wrap(<PortalPage slug="djdl" />);
const renderSignIn = () => wrap(<SignInPage slug="djdl" />);

function toggle(name: string): HTMLElement {
  return screen.getByRole("switch", { name });
}

function checked(el: HTMLElement): boolean {
  return el.getAttribute("aria-checked") === "true";
}

const saveButton = () =>
  screen.queryByRole("button", { name: "Save portal settings" });

async function axeViolations(container: HTMLElement): Promise<string[]> {
  const results = await axe(container);
  return results.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );
}

beforeEach(() => {
  resetCache();
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
  portalSettings.mockResolvedValue({ settings: PORTAL });
  updatePortalSettings.mockResolvedValue({ ok: true, settings: PORTAL });
  product.mockResolvedValue({ product: PRODUCT });
  edgeMintRecipes.mockResolvedValue(mintResponse(CUSTOM));
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

// ── Identity → Portal ──────────────────────────────────────────────────────────────────────────

describe("Identity → Portal", () => {
  it("titles the page Portal, matching its sidebar item (IDN-5)", async () => {
    renderPortal();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Portal" }),
    ).toBeTruthy();
  });

  it("shows a loading state and never the code defaults while the endpoint is pending (IDN-4)", async () => {
    let resolve!: (v: { settings: PortalProductSettings }) => void;
    portalSettings.mockReturnValue(new Promise((r) => (resolve = r)));
    renderPortal();

    await waitFor(() =>
      expect(document.querySelector('[data-skeleton="form"]')).not.toBeNull(),
    );
    // The defaults have every module on; none of them may stand in for the real value.
    expect(screen.queryByRole("switch")).toBeNull();

    resolve({ settings: PORTAL });
    await waitFor(() => expect(checked(toggle("OIDC access"))).toBe(false));
  });

  it("renders all five portal modules at the state the identity endpoint reported", async () => {
    renderPortal();
    // Five separate switches, not one "portal on/off": each is a module a customer either can or
    // cannot reach, and collapsing them would make "portal on" mean five different things.
    await waitFor(() => {
      expect(checked(toggle("OIDC access"))).toBe(false);
      expect(checked(toggle("License-key claim"))).toBe(false);
    });
    expect(checked(toggle("Customer portal"))).toBe(true);
    expect(checked(toggle("Email magic links"))).toBe(true);
    expect(checked(toggle("Release downloads"))).toBe(true);
  });

  it("renders the two license-key switches (PX-W5) and saves a change to them", async () => {
    renderPortal();
    await waitFor(() =>
      expect(checked(toggle("Customers can get a new key"))).toBe(false),
    );
    expect(checked(toggle("Add by key without the purchase email"))).toBe(true);
    await userEvent.click(toggle("Customers can get a new key"));
    await userEvent.click(saveButton()!);
    await waitFor(() => expect(updatePortalSettings).toHaveBeenCalledTimes(1));
    expect(updatePortalSettings.mock.calls[0]![1]).toMatchObject({
      keyReissueEnabled: true,
      claimByKey: true,
    });
  });

  it("renders the Discover switch (PX-W10), on by default, and saves turning it off", async () => {
    portalSettings.mockResolvedValue({
      settings: { ...PORTAL, discoverEnabled: undefined },
    });
    renderPortal();
    await waitFor(() =>
      expect(checked(toggle("Offer on Discover"))).toBe(true),
    );
    await userEvent.click(toggle("Offer on Discover"));
    await userEvent.click(saveButton()!);
    await waitFor(() => expect(updatePortalSettings).toHaveBeenCalledTimes(1));
    expect(updatePortalSettings.mock.calls[0]![1]).toMatchObject({
      discoverEnabled: false,
    });
  });

  it("reads the portal state through the identity endpoint, not the copy on the product row", async () => {
    // `identity/portal` OWNS the table. Seeding from the product row's embedded copy would show a
    // value a save does not round-trip against.
    product.mockResolvedValue({
      product: {
        ...PRODUCT,
        portalSettings: { ...PORTAL, portalEnabled: false, oidcEnabled: true },
      },
    });
    renderPortal();
    await waitFor(() => {
      expect(checked(toggle("OIDC access"))).toBe(false);
      expect(checked(toggle("Customer portal"))).toBe(true);
    });
    expect(portalSettings).toHaveBeenCalledWith("djdl");
  });

  it("says when the settings were last changed, and when they never were", async () => {
    renderPortal();
    expect(await screen.findByText(/^Edited/)).toBeTruthy();
    cleanup();
    resetCache();
    portalSettings.mockResolvedValue({
      settings: { ...PORTAL, modifiedAt: 0 },
    });
    renderPortal();
    expect(await screen.findByText("Defaults")).toBeTruthy();
  });

  it("offers no Save until a module actually moves", async () => {
    renderPortal();
    await waitFor(() => expect(checked(toggle("OIDC access"))).toBe(false));
    expect(saveButton()).toBeNull();
    expect(updatePortalSettings).not.toHaveBeenCalled();

    await userEvent.click(toggle("OIDC access"));
    expect(saveButton()).not.toBeNull();
    // Moving it back leaves nothing to save.
    await userEvent.click(toggle("OIDC access"));
    await waitFor(() => expect(saveButton()).toBeNull());
  });

  it("saves the whole module set through updatePortalSettings and refetches the portal settings", async () => {
    renderPortal();
    await waitFor(() => expect(checked(toggle("OIDC access"))).toBe(false));
    expect(portalSettings).toHaveBeenCalledTimes(1);

    await userEvent.click(toggle("OIDC access"));
    await userEvent.click(saveButton()!);

    await waitFor(() => expect(updatePortalSettings).toHaveBeenCalledTimes(1));
    const [slug, body] = updatePortalSettings.mock.calls[0]!;
    expect(slug).toBe("djdl");
    expect(body).toEqual({
      portalEnabled: true,
      oidcEnabled: true,
      magicEnabled: true,
      licenseKeyClaimEnabled: false,
      releasesEnabled: true,
      keyReissueEnabled: false,
      claimByKey: true,
      discoverEnabled: true,
      autoLinkEnabled: null,
    });
    // `branding` is a blob this page only reads; sending it back could overwrite it.
    expect("branding" in body).toBe(false);
    // The invalidation table: `portal settings` → the portal query.
    await waitFor(() => expect(portalSettings).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Portal settings saved")).toBeTruthy();
  });

  it("keeps the draft and says why when a save fails", async () => {
    updatePortalSettings.mockRejectedValue(new Error("Database unavailable"));
    renderPortal();
    await waitFor(() => expect(checked(toggle("OIDC access"))).toBe(false));

    await userEvent.click(toggle("OIDC access"));
    await userEvent.click(saveButton()!);

    await waitFor(() => expect(updatePortalSettings).toHaveBeenCalledTimes(1));
    expect(
      (await screen.findAllByText(/Database unavailable/)).length,
    ).toBeGreaterThan(0);
    expect(checked(toggle("OIDC access"))).toBe(true);
    expect(saveButton()).not.toBeNull();
  });

  it("targets …/identity/portal on the wire", async () => {
    // The rest of this suite runs against a mocked `api`; this one case exercises the REAL client.
    const actual =
      await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
    const fetchSpy = vi.fn(
      async (_path: string, _init?: RequestInit) =>
        ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, settings: PORTAL }),
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await actual.api.portalSettings("djdl");
      await actual.api.updatePortalSettings("djdl", { oidcEnabled: true });
    } finally {
      vi.unstubAllGlobals();
    }

    const [readPath] = fetchSpy.mock.calls[0]!;
    const [writePath, writeInit] = fetchSpy.mock.calls[1]!;
    expect(readPath).toBe("/manage/api/products/djdl/identity/portal");
    expect(writePath).toBe("/manage/api/products/djdl/identity/portal");
    expect(writeInit?.method).toBe("PATCH");
  });

  it("renders automatic linking as a TRI-STATE, defaulting to auto", async () => {
    // R5-01/R5-02: `null` means "follow the OIDC issuer". A switch cannot express that.
    renderPortal();
    const control = await screen.findByRole("combobox", {
      name: "Automatic license linking",
    });
    expect(control.textContent).toContain("Auto");
    expect(
      screen.queryByRole("switch", { name: "Automatic license linking" }),
    ).toBeNull();
  });

  it("sends an explicit override, and can return to auto", async () => {
    portalSettings.mockResolvedValue({
      settings: { ...PORTAL, autoLinkEnabled: false },
    });
    renderPortal();
    const control = await screen.findByRole("combobox", {
      name: "Automatic license linking",
    });
    await waitFor(() => expect(control.textContent).toContain("Never link"));

    await userEvent.click(control);
    await userEvent.click(
      await screen.findByRole("option", { name: /Always link/ }),
    );
    await userEvent.click(saveButton()!);
    await waitFor(() => expect(updatePortalSettings).toHaveBeenCalledTimes(1));
    expect(updatePortalSettings.mock.calls[0]![1]).toMatchObject({
      autoLinkEnabled: true,
    });

    await waitFor(() => expect(saveButton()).toBeNull());
    await userEvent.click(
      screen.getByRole("combobox", { name: "Automatic license linking" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: /Auto \(follow/ }),
    );
    await userEvent.click(saveButton()!);
    await waitFor(() => expect(updatePortalSettings).toHaveBeenCalledTimes(2));
    expect(updatePortalSettings.mock.calls[1]![1]).toMatchObject({
      autoLinkEnabled: null,
    });
  });

  it("locks the sign-in methods and modules while the portal is off (IDN-3)", async () => {
    portalSettings.mockResolvedValue({
      settings: { ...PORTAL, portalEnabled: false },
    });
    renderPortal();
    await waitFor(() => expect(checked(toggle("Customer portal"))).toBe(false));

    for (const name of [
      "OIDC access",
      "Email magic links",
      "License-key claim",
      "Release downloads",
      "Customers can get a new key",
      "Add by key without the purchase email",
      "Offer on Discover",
    ]) {
      expect(toggle(name).hasAttribute("disabled"), name).toBe(true);
    }
    expect(
      screen
        .getByRole("combobox", { name: "Automatic license linking" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getAllByText("Turn on the customer portal to change this.").length,
    ).toBe(4);

    // Turning the portal on in the draft unlocks them.
    await userEvent.click(toggle("Customer portal"));
    expect(toggle("OIDC access").hasAttribute("disabled")).toBe(false);
    expect(toggle("Release downloads").hasAttribute("disabled")).toBe(false);
  });

  it("locks Release downloads while the Release service is off, with a way to Services (IDN-3)", async () => {
    product.mockResolvedValue({
      product: {
        ...PRODUCT,
        services: { ...PRODUCT.services!, release: { enabled: false } },
      },
    });
    renderPortal();
    await waitFor(() =>
      expect(toggle("Release downloads").hasAttribute("disabled")).toBe(true),
    );
    expect(toggle("OIDC access").hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(/Release is off for this product/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open Services" }).getAttribute("href"),
    ).toBe("#/p/djdl/services");
  });

  it("shows branding as a read-out: none, or the stored value (IDN-4)", async () => {
    renderPortal();
    expect(
      await screen.findByText(
        "None. The portal shows the product name in the Polaris Key theme.",
      ),
    ).toBeTruthy();
    cleanup();
    resetCache();
    portalSettings.mockResolvedValue({
      settings: { ...PORTAL, branding: { accent: "#7c3aed" } },
    });
    renderPortal();
    const tree = await screen.findByRole("tree", { name: "Portal branding" });
    expect(within(tree).getByText(/#7c3aed/)).toBeTruthy();
    // Read-only: no input edits it.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows an error state with a working retry when portal settings fail to load", async () => {
    portalSettings
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValue({ settings: PORTAL });
    renderPortal();

    const alert = await screen.findByRole("alert");
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("switch", { name: "Customer portal" }),
    ).toBeTruthy();
  });

  it("passes axe", async () => {
    const { container } = renderPortal();
    await waitFor(() => expect(checked(toggle("OIDC access"))).toBe(false));
    expect(await axeViolations(container)).toEqual([]);
  });
});

// ── Identity → Sign-in ─────────────────────────────────────────────────────────────────────────

describe("Identity → Sign-in", () => {
  it("titles the page Sign-in and states that identity config is manifest-authored", async () => {
    renderSignIn();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Sign-in" }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "Where it is authored" }),
    ).toBeTruthy();
    expect(screen.getAllByText(".pkey/product").length).toBeGreaterThan(0);
    // No console-side editor is offered for any of it.
    expect(screen.queryByRole("combobox", { name: /provider/i })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /client/i })).toBeNull();
  });

  it("shows the current provider, issuer and client from config/mint (IDN-2)", async () => {
    renderSignIn();
    expect(await screen.findByText("Custom")).toBeTruthy();
    expect(screen.getByText("https://id.djdl.example")).toBeTruthy();
    expect(screen.getAllByText(/djdl-console-client/).length).toBeGreaterThan(
      0,
    );
    expect(edgeMintRecipes).toHaveBeenCalledWith("djdl");
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
    renderSignIn();
    expect(await screen.findByText("Platform OIDC")).toBeTruthy();
    expect(screen.getByText("The platform issuer")).toBeTruthy();
    expect(screen.getByText("The platform client")).toBeTruthy();
    expect(screen.getByText("No groups are mapped.")).toBeTruthy();
  });

  it("lists the group map with each tier linked to its record", async () => {
    renderSignIn();
    const table = await screen.findByRole("table", {
      name: "Groups and tiers",
    });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText("djdl-pro")).toBeTruthy();
    expect(
      within(rows[1]!).getByRole("link", { name: "pro" }).getAttribute("href"),
    ).toBe("#/p/djdl/license/tiers/pro");
    expect(within(rows[2]!).getByText("Entitlement only")).toBeTruthy();
  });

  it("says what happens to a signed-in account in no mapped group", async () => {
    renderSignIn();
    expect(await screen.findByText(/is refused \(not entitled\)/)).toBeTruthy();
    cleanup();
    resetCache();
    edgeMintRecipes.mockResolvedValue(mintResponse(CUSTOM, true));
    renderSignIn();
    expect(
      await screen.findByText(/gets the auto-issue default tier/),
    ).toBeTruthy();
  });

  it("flags a group map that does not parse", async () => {
    edgeMintRecipes.mockResolvedValue(
      mintResponse({ ...CUSTOM, groupRoleMapJson: "{not json" }),
    );
    renderSignIn();
    expect(
      await screen.findByText(/The stored group map is not valid JSON/),
    ).toBeTruthy();
  });

  it("with Identity on but no identity block, shows the platform OIDC default", async () => {
    edgeMintRecipes.mockResolvedValue(mintResponse(null));
    renderSignIn();
    expect(await screen.findByText("Platform OIDC")).toBeTruthy();
    expect(
      screen.queryByRole("heading", {
        name: "Identity is off for this product",
      }),
    ).toBeNull();
  });

  it("shows the service-off state when Identity is off", async () => {
    product.mockResolvedValue({
      product: {
        ...PRODUCT,
        services: { ...PRODUCT.services!, identity: { enabled: false } },
      },
    });
    edgeMintRecipes.mockResolvedValue(mintResponse(null));
    renderSignIn();
    expect(
      await screen.findByRole("heading", {
        name: "Identity is off for this product",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open Services" }).getAttribute("href"),
    ).toBe("#/p/djdl/services");
  });

  it("shows a loading state, then an error state with a working retry", async () => {
    edgeMintRecipes
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValue(mintResponse(CUSTOM));
    renderSignIn();
    expect(document.querySelector('[data-skeleton="record"]')).not.toBeNull();

    const alert = await screen.findByRole("alert");
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Custom")).toBeTruthy();
  });

  it("confirms a resync (L1, caution) with the plan before running it (IDN-1, UX-78)", async () => {
    resyncProduct.mockResolvedValue({
      ok: true,
      slug: "djdl",
      updated: ["oidc"],
    });
    renderSignIn();
    await screen.findByText("Custom");

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
    renderSignIn();

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
    const { container } = renderSignIn();
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
