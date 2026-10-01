import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  PortalProductSettings,
  ProductDetail,
  ResyncResult,
  UpdatePortalSettingsBody,
} from "../src/api.js";
import { resetCache } from "../src/context.js";
import { Toaster } from "../src/components/ui/index.js";

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
    },
  };
});

const { Identity } = await import("../src/views/Identity.js");

const PORTAL: PortalProductSettings = {
  portalEnabled: true,
  oidcEnabled: false,
  magicEnabled: true,
  licenseKeyClaimEnabled: false,
  releasesEnabled: true,
  autoLinkEnabled: null,
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
};

function renderIdentity() {
  return render(
    <Toaster>
      <Identity slug="djdl" />
    </Toaster>,
  );
}

function toggle(name: string): HTMLElement {
  return screen.getByRole("switch", { name });
}

function checked(el: HTMLElement): boolean {
  return el.getAttribute("aria-checked") === "true";
}

beforeEach(() => {
  resetCache();
  portalSettings.mockReset();
  updatePortalSettings.mockReset();
  product.mockReset();
  resyncProduct.mockReset();
  portalSettings.mockResolvedValue({ settings: PORTAL });
  updatePortalSettings.mockResolvedValue({ ok: true, settings: PORTAL });
  product.mockResolvedValue({ product: PRODUCT });
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

describe("Identity — the customer portal card", () => {
  it("renders all five portal modules at the state the identity endpoint reported", async () => {
    renderIdentity();

    // Five separate switches, not one "portal on/off": each is a module a customer either can or
    // cannot reach, and collapsing them would make "portal on" mean five different things.
    //
    // Wait for the SETTLED value, not merely for the switch to exist: the card seeds its form
    // from the response in an effect, so the switches are briefly in the DOM at their initial
    // state and `findByRole` can resolve on that one render when the machine is busy. The
    // defaults already have the portal (and every other module) on, so wait on the two switches
    // the fixture turns OFF — only the settled response can produce those.
    await waitFor(() => {
      expect(checked(toggle("OIDC access"))).toBe(false);
      expect(checked(toggle("License-key claim"))).toBe(false);
    });
    expect(checked(toggle("Customer portal"))).toBe(true);
    expect(checked(toggle("Email magic links"))).toBe(true);
    expect(checked(toggle("Release downloads"))).toBe(true);
  });

  it("reads the portal state through the identity endpoint, not the copy on the product row", async () => {
    // `identity/portal` OWNS the table. Seeding the form from the product row's embedded copy
    // would show a value a save does not round-trip against, so the two would drift apart after
    // the first write.
    product.mockResolvedValue({
      product: {
        ...PRODUCT,
        portalSettings: { ...PORTAL, portalEnabled: false, oidcEnabled: true },
      },
    });
    renderIdentity();

    // Wait on the value only the endpoint supplies: the form's defaults already show the portal
    // switch on (and OIDC on), so waiting on the portal switch alone passed before the endpoint
    // answered and the OIDC assertion then raced it.
    await waitFor(() => {
      expect(checked(toggle("OIDC access"))).toBe(false);
      expect(checked(toggle("Customer portal"))).toBe(true);
    });
    expect(portalSettings).toHaveBeenCalledWith("djdl");
  });

  it("saves the whole module set through updatePortalSettings", async () => {
    renderIdentity();
    await screen.findByRole("switch", { name: "Customer portal" });

    await userEvent.click(toggle("OIDC access"));
    await userEvent.click(
      screen.getByRole("button", { name: "Save portal settings" }),
    );

    await waitFor(() => expect(updatePortalSettings).toHaveBeenCalledTimes(1));
    const [slug, body] = updatePortalSettings.mock.calls[0]!;
    expect(slug).toBe("djdl");
    expect(body).toEqual({
      portalEnabled: true,
      oidcEnabled: true,
      magicEnabled: true,
      licenseKeyClaimEnabled: false,
      releasesEnabled: true,
      autoLinkEnabled: null,
    });
    // `branding` is a blob this card never renders; sending it back would let a console that
    // cannot show branding overwrite it.
    expect("branding" in body).toBe(false);
  });

  it("targets …/identity/portal on the wire", async () => {
    // The rest of this suite runs against a mocked `api`, so nothing in it would notice the module
    // still pointing at the old product-settings path. This one case exercises the REAL client.
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
    // R5-01/R5-02: `null` means "follow the OIDC issuer". A switch cannot express that — it
    // would have to render `null` as on or off, and the first touch would freeze a value that
    // is supposed to track the issuer. So it is a select with "auto" as a nameable choice.
    renderIdentity();
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
    renderIdentity();
    const control = await screen.findByRole("combobox", {
      name: "Automatic license linking",
    });
    expect(control.textContent).toContain("Never link");

    await userEvent.click(control);
    await userEvent.click(
      await screen.findByRole("option", { name: /Always link/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save portal settings" }),
    );

    await waitFor(() => expect(updatePortalSettings).toHaveBeenCalledTimes(1));
    expect(updatePortalSettings.mock.calls[0]![1]).toMatchObject({
      autoLinkEnabled: true,
    });
  });

  it("keeps save inert until a module actually moves", async () => {
    renderIdentity();
    await screen.findByRole("switch", { name: "Customer portal" });

    expect(
      screen
        .getByRole("button", { name: "Save portal settings" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(updatePortalSettings).not.toHaveBeenCalled();
  });

  it("shows an empty state with a working retry when portal settings fail to load", async () => {
    portalSettings.mockReset();
    portalSettings
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValue({ settings: PORTAL });
    renderIdentity();

    expect(
      await screen.findByText("Couldn’t load portal settings"),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("switch", { name: "Customer portal" }),
    ).toBeTruthy();
  });
});

describe("Identity — the OIDC explainer absorbed from views/Oidc.tsx", () => {
  it("still states that identity config is manifest-authored and un-editable here", async () => {
    renderIdentity();

    // The substance the standalone tab existed to deliver: WHERE the four un-editable things are
    // authored, and that the admin API has no write path for them. An operator who turns "OIDC
    // access" on above and then hunts for a provider form has been handed half an answer.
    expect(
      await screen.findByText(/Identity config is authored in your repo/),
    ).toBeTruthy();
    expect(
      screen.getByText(/The admin API does not expose OIDC settings/),
    ).toBeTruthy();
    expect(screen.getAllByText(".pkey/product").length).toBeGreaterThan(0);
    // The escape hatch: platform OIDC is the default, and `custom` is the opt-out.
    expect(screen.getByText("oidc.provider: custom")).toBeTruthy();
    // No console-side editor is offered for any of it.
    expect(screen.queryByRole("combobox", { name: /provider/i })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /client/i })).toBeNull();
  });

  it("offers re-sync as the one action the API does support", async () => {
    resyncProduct.mockResolvedValue({ ok: true, slug: "djdl" });
    renderIdentity();

    const button = await screen.findByRole("button", {
      name: /Re-sync from linked repo/,
    });
    await userEvent.click(button);
    await waitFor(() => expect(resyncProduct).toHaveBeenCalledWith("djdl"));
  });

  it("gates re-sync on the product actually being linked to a repo", async () => {
    // `release/resync.ts` 422s anything whose `release_source` is not `github`, so an enabled
    // button on a manual product is an affordance the server is guaranteed to refuse.
    product.mockResolvedValue({
      product: { ...PRODUCT, releaseSource: "manual" },
    });
    renderIdentity();

    const button = await screen.findByRole("button", {
      name: /Re-sync from linked repo/,
    });
    expect(button.hasAttribute("disabled")).toBe(true);
    await userEvent.click(button);
    expect(resyncProduct).not.toHaveBeenCalled();
  });

  it("keeps the explainer up when the portal card cannot load", async () => {
    // The two cards load independently on purpose: a portal-settings failure must not hide the
    // one card that tells the operator where identity config actually lives.
    portalSettings.mockRejectedValue(new Error("nope"));
    renderIdentity();

    expect(
      await screen.findByText("Couldn’t load portal settings"),
    ).toBeTruthy();
    expect(
      screen.getByText(/Identity config is authored in your repo/),
    ).toBeTruthy();
  });
});
