import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  PortalProductSettings,
  ServicesDryRun,
  ServicesResponse,
  UpdatePortalSettingsBody,
  UpdateServicesBody,
} from "../src/api.js";
import { ApiError } from "../src/api.js";
import { renderAt, resetCore } from "./coreTestUtils.js";
import { ServicesPage } from "../src/console/sections/core/pages/Services.js";

const services = vi.fn<(slug: string) => Promise<ServicesResponse>>();
const updateServices =
  vi.fn<
    (slug: string, body: UpdateServicesBody) => Promise<ServicesResponse>
  >();
const revertServices = vi.fn<(slug: string) => Promise<ServicesResponse>>();
const servicesDryRun =
  vi.fn<(slug: string, body: UpdateServicesBody) => Promise<ServicesDryRun>>();
const packageFeeds =
  vi.fn<
    (
      slug: string,
    ) => Promise<{ packageFeeds: { enabled: boolean; version: number } }>
  >();
const savePackageFeeds = vi.fn<
  (
    slug: string,
    body: { enabled: boolean; expectedVersion: number },
  ) => Promise<{
    ok: true;
    packageFeeds: { enabled: boolean; version: number };
  }>
>();
const portalSettings =
  vi.fn<(slug: string) => Promise<{ settings: PortalProductSettings }>>();
const updatePortalSettings =
  vi.fn<
    (
      slug: string,
      body: UpdatePortalSettingsBody,
    ) => Promise<{ ok: true; settings: PortalProductSettings }>
  >();

vi.mock("../src/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return {
    ...actual,
    api: {
      services: (slug: string) => services(slug),
      updateServices: (slug: string, body: UpdateServicesBody) =>
        updateServices(slug, body),
      revertServices: (slug: string) => revertServices(slug),
      servicesDryRun: (slug: string, body: UpdateServicesBody) =>
        servicesDryRun(slug, body),
      packageFeeds: (slug: string) => packageFeeds(slug),
      savePackageFeeds: (
        slug: string,
        body: { enabled: boolean; expectedVersion: number },
      ) => savePackageFeeds(slug, body),
      portalSettings: (slug: string) => portalSettings(slug),
      updatePortalSettings: (slug: string, body: UpdatePortalSettingsBody) =>
        updatePortalSettings(slug, body),
    },
  };
});

const state = (over: Partial<ServicesResponse> = {}): ServicesResponse => ({
  services: {
    license: { enabled: true },
    config: { enabled: true },
    release: { enabled: false },
    distribution: { enabled: false },
    update: { enabled: false },
    identity: { enabled: false },
    sync: { enabled: false },
    commerce: { enabled: false },
  },
  effectiveRegistration: "requires-license",
  source: "manifest",
  facts: {
    licensing: { tiers: 2, licenses: 3 },
    managedConfig: { catalogVersion: 4 },
    shipBuilds: { latest: null },
    commerce: { storefronts: 0, storeGrants: 0 },
  },
  ...over,
});
const portal: PortalProductSettings = {
  portalEnabled: false,
};
const mount = () =>
  renderAt("#/p/djdl/settings/features", <ServicesPage slug="djdl" />);
const feature = (name: string) =>
  screen.getByRole("switch", { name: new RegExp(name, "i") });

afterEach(cleanup);
beforeEach(() => {
  resetCore();
  services.mockReset().mockResolvedValue(state());
  updateServices.mockReset();
  revertServices.mockReset();
  servicesDryRun.mockReset().mockResolvedValue({
    changes: [],
    cascaded: [],
    signedInDevicesToClear: 0,
  });
  packageFeeds
    .mockReset()
    .mockResolvedValue({ packageFeeds: { enabled: false, version: 1 } });
  savePackageFeeds.mockReset().mockResolvedValue({
    ok: true,
    packageFeeds: { enabled: false, version: 1 },
  });
  portalSettings.mockReset().mockResolvedValue({ settings: portal });
  updatePortalSettings.mockReset().mockResolvedValue({
    ok: true,
    settings: { ...portal, portalEnabled: true },
  });
});

describe("Services feature groups", () => {
  it("renders the five generated feature controls and GET facts", async () => {
    mount();
    for (const name of [
      "Licensing",
      "Managed config",
      "Ship builds",
      "Sign-in",
      "Cloud Sync",
    ])
      expect(
        await screen.findByRole("switch", {
          name: new RegExp(`^${name}(,|$)`, "i"),
        }),
      ).toBeTruthy();
    expect(screen.getByText(/2 tiers/)).toBeTruthy();
    expect(screen.getAllByText(/Catalog v4/)).toHaveLength(1);
  });

  it("B-047: a feature that is off does not repeat Off beside its Off switch", async () => {
    mount();
    const sw = await screen.findByRole("switch", { name: /^Licensing/i });
    const off = (await screen.findAllByRole("switch")).filter(
      (el) => el.getAttribute("aria-checked") === "false",
    );
    expect(off.length).toBeGreaterThan(0);
    expect(sw).toBeTruthy();
    expect(screen.queryByText(/^Off$/)).toBeNull();
  });

  it("enables Ship builds with one audited three-service PATCH and retains GET facts", async () => {
    const user = userEvent.setup();
    const next = state({
      services: {
        ...state().services,
        release: { enabled: true },
        distribution: { enabled: true },
        update: { enabled: true },
      },
      source: "admin",
    });
    updateServices.mockResolvedValue(next);
    mount();
    await user.click(
      await screen.findByRole("switch", { name: /Ship builds/i }),
    );
    await waitFor(() =>
      expect(updateServices).toHaveBeenCalledWith("djdl", {
        services: {
          release: { enabled: true },
          distribution: { enabled: true },
          update: { enabled: true },
        },
      }),
    );
    expect(screen.getByText(/2 tiers/)).toBeTruthy();
  });

  it("uses the server dry run to confirm cascades before disabling", async () => {
    const user = userEvent.setup();
    services.mockResolvedValue(
      state({
        services: {
          ...state().services,
          release: { enabled: true },
          distribution: { enabled: true },
          update: { enabled: true },
        },
      }),
    );
    // Ship builds off asks for Release and Distribution only; the Worker cascades Update.
    servicesDryRun.mockResolvedValue({
      changes: [],
      cascaded: ["update"],
      signedInDevicesToClear: 0,
    });
    mount();
    await user.click(
      await screen.findByRole("switch", { name: /Ship builds/i }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(servicesDryRun).toHaveBeenCalledWith("djdl", {
      services: {
        release: { enabled: false },
        distribution: { enabled: false },
      },
    });
    expect(
      within(dialog).getByText(
        "Also turns off In-app updates because it needs Ship builds.",
      ),
    ).toBeTruthy();
    expect(updateServices).not.toHaveBeenCalled();
  });

  it("names a cascaded service by its service-table label, not its slug", async () => {
    const user = userEvent.setup();
    services.mockResolvedValue(
      state({
        services: {
          ...state().services,
          identity: { enabled: true },
          sync: { enabled: true },
        },
      }),
    );
    servicesDryRun.mockResolvedValue({
      changes: [],
      cascaded: ["sync"],
      signedInDevicesToClear: 0,
    });
    mount();
    await user.click(await screen.findByRole("switch", { name: /^Sign-in$/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/Also turns off Cloud Sync because/),
    ).toBeTruthy();
  });

  it("announces a 422 refusal, describes the requested switch with it, and clears on the next try", async () => {
    const user = userEvent.setup();
    updateServices.mockRejectedValueOnce(
      new ApiError(422, undefined, "bad_request", ["sync_requires_identity"]),
    );
    services.mockResolvedValue(
      state({ services: { ...state().services, identity: { enabled: true } } }),
    );
    mount();
    const sync = await screen.findByRole("switch", { name: /Cloud Sync/i });
    expect(sync.getAttribute("aria-describedby")).toBeNull();
    expect(sync.getAttribute("aria-invalid")).toBeNull();

    await user.click(sync);
    expect(await screen.findByText(/Cloud Sync needs Sign-in/)).toBeTruthy();
    const title = document.getElementById("feature-cloud-sync-error")!;
    const detail = document.getElementById("feature-cloud-sync-error-detail")!;
    expect(title.textContent).toBe("The server refused this change");
    expect(detail.textContent).toMatch(/Cloud Sync needs Sign-in/);
    // The callout is a live region, so the refusal is announced when it appears.
    expect(title.closest('[role="status"]')).toBe(
      detail.closest('[role="status"]'),
    );
    expect(title.closest('[role="status"]')).not.toBeNull();
    expect(sync.getAttribute("aria-invalid")).toBe("true");
    expect(sync.getAttribute("aria-describedby")).toBe(
      "feature-cloud-sync-error feature-cloud-sync-error-detail",
    );

    // The next attempt clears the refusal and the switch's description.
    updateServices.mockResolvedValueOnce(
      state({
        services: {
          ...state().services,
          identity: { enabled: true },
          sync: { enabled: true },
        },
      }),
    );
    await user.click(sync);
    await waitFor(() =>
      expect(document.getElementById("feature-cloud-sync-error")).toBeNull(),
    );
    expect(
      document.getElementById("feature-cloud-sync-error-detail"),
    ).toBeNull();
    expect(sync.getAttribute("aria-describedby")).toBeNull();
    expect(sync.getAttribute("aria-invalid")).toBeNull();
  });

  it("announces a generic failure, describes the requested switch with it, and retries", async () => {
    const user = userEvent.setup();
    updateServices.mockRejectedValueOnce(new Error("write failed"));
    services.mockResolvedValue(
      state({ services: { ...state().services, identity: { enabled: true } } }),
    );
    mount();
    const sync = await screen.findByRole("switch", { name: /Cloud Sync/i });

    await user.click(sync);
    const title = await screen.findByText("Something went wrong");
    expect(title.id).toBe("feature-cloud-sync-error");
    expect(title.closest('[role="status"]')).not.toBeNull();
    expect(sync.getAttribute("aria-invalid")).toBe("true");
    expect(sync.getAttribute("aria-describedby")!.split(" ")).toContain(
      title.id,
    );
    for (const id of sync.getAttribute("aria-describedby")!.split(" "))
      expect(document.getElementById(id)).not.toBeNull();

    updateServices.mockResolvedValueOnce(
      state({
        services: {
          ...state().services,
          identity: { enabled: true },
          sync: { enabled: true },
        },
      }),
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(updateServices).toHaveBeenCalledTimes(2));
    expect(updateServices).toHaveBeenLastCalledWith("djdl", {
      services: { sync: { enabled: true } },
    });
    await waitFor(() =>
      expect(screen.queryByText("Something went wrong")).toBeNull(),
    );
    expect(sync.getAttribute("aria-describedby")).toBeNull();
    expect(sync.getAttribute("aria-invalid")).toBeNull();
  });

  it("describes only the In-app updates switch when its own change fails", async () => {
    const user = userEvent.setup();
    updateServices.mockRejectedValueOnce(new Error("write failed"));
    services.mockResolvedValue(
      state({
        services: {
          ...state().services,
          release: { enabled: true },
          distribution: { enabled: true },
        },
      }),
    );
    mount();
    const updates = await screen.findByRole("switch", {
      name: /In-app updates/i,
    });
    const shipBuilds = screen.getByRole("switch", { name: /Ship builds/i });
    expect(updates.getAttribute("aria-describedby")).toBeNull();

    await user.click(updates);
    await screen.findByText("Something went wrong");
    expect(updates.getAttribute("aria-invalid")).toBe("true");
    expect(updates.getAttribute("aria-describedby")).toBe(
      "feature-ship-builds-error feature-ship-builds-error-detail",
    );
    expect(shipBuilds.getAttribute("aria-invalid")).toBeNull();
    expect(shipBuilds.getAttribute("aria-describedby")).toBeNull();
  });

  it("announces a failed dry run beside Ship builds, keeps ids unique, and retries it", async () => {
    const user = userEvent.setup();
    services.mockResolvedValue(
      state({
        services: {
          ...state().services,
          release: { enabled: true },
          distribution: { enabled: true },
          update: { enabled: true },
        },
      }),
    );
    servicesDryRun.mockRejectedValueOnce(new Error("dry run failed"));
    const { container } = mount();
    const shipBuilds = await screen.findByRole("switch", {
      name: /Ship builds/i,
    });
    await user.click(shipBuilds);
    const title = await screen.findByText("Something went wrong");
    expect(title.id).toBe("feature-ship-builds-error");
    expect(title.closest('[role="status"]')).not.toBeNull();
    expect(shipBuilds.getAttribute("aria-invalid")).toBe("true");
    expect(shipBuilds.getAttribute("aria-describedby")).toBe(
      "feature-ship-builds-error feature-ship-builds-error-detail",
    );
    const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);

    servicesDryRun.mockResolvedValueOnce({
      changes: [],
      cascaded: ["update"],
      signedInDevicesToClear: 0,
    });
    await user.click(screen.getByRole("button", { name: "Retry" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(
        "Also turns off In-app updates because it needs Ship builds.",
      ),
    ).toBeTruthy();
    expect(shipBuilds.getAttribute("aria-describedby")).toBeNull();
    expect(shipBuilds.getAttribute("aria-invalid")).toBeNull();
  });

  it("keeps every id on the page unique so each label binds to its own switch", async () => {
    const { container } = mount();
    await screen.findByRole("switch", { name: /Licensing/i });
    const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
    expect(ids.length).toBeGreaterThan(5);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("blocks Cloud Sync while Sign-in is off and says what it needs", async () => {
    mount();
    const sync = await screen.findByRole("switch", { name: /Cloud Sync/i });
    expect(sync.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/Turn on Sign-in first/i)).toBeTruthy();
    // Focusable (Tab reaches it) and inert: a click changes nothing.
    sync.focus();
    expect(document.activeElement).toBe(sync);
    await userEvent.setup().click(sync);
    expect(updateServices).not.toHaveBeenCalled();
    expect(servicesDryRun).not.toHaveBeenCalled();
    // The reason moves focus to the switch that fixes it.
    await userEvent.setup().click(screen.getByText(/Turn on Sign-in first/i));
    expect(document.activeElement?.id).toBe("feature-sign-in-switch");
  });

  it("shows the Edge mint recipe approval path for minted tokens", async () => {
    mount();
    const copy = await screen.findByText(
      "A recipe mints only after an operator approves it",
    );
    expect(copy).toBeTruthy();
    const review = screen.getByRole("link", { name: "Review recipe" });
    expect(review.getAttribute("href")).toBe("#/p/djdl/config/catalog");
    expect(screen.getAllByText(/Catalog v4/)).toHaveLength(1);
  });

  it("loads Polaris Locker settings and retries the failed requested state", async () => {
    const user = userEvent.setup();
    updatePortalSettings.mockRejectedValueOnce(
      new Error("Polaris Locker write failed"),
    );
    services.mockResolvedValue(
      state({ services: { ...state().services, identity: { enabled: true } } }),
    );
    mount();
    const customerPortal = await screen.findByRole("switch", {
      name: /Polaris Locker/i,
    });
    await waitFor(() => expect(portalSettings).toHaveBeenCalledWith("djdl"));
    expect(customerPortal.getAttribute("aria-describedby")).toBeNull();

    await user.click(customerPortal);
    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    // The failure is announced, and the switch that reset is described by it.
    const alert = screen.getByRole("alert");
    expect(alert.id).toBe("feature-customer-portal-error");
    expect(alert.textContent).toBe("Something went wrong");
    expect(customerPortal.getAttribute("aria-describedby")).toBe(alert.id);
    expect(updatePortalSettings).toHaveBeenLastCalledWith("djdl", {
      portalEnabled: true,
    });

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(updatePortalSettings).toHaveBeenLastCalledWith("djdl", {
        portalEnabled: true,
      }),
    );
    expect(updatePortalSettings).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(customerPortal.getAttribute("aria-describedby")).toBeNull();
  });

  it("names a package feed version conflict and reloads it", async () => {
    const user = userEvent.setup();
    services.mockResolvedValue(
      state({
        services: {
          ...state().services,
          release: { enabled: true },
          distribution: { enabled: true },
          update: { enabled: true },
        },
      }),
    );
    savePackageFeeds.mockRejectedValueOnce(
      new ApiError(409, undefined, "version_conflict"),
    );
    mount();
    const packages = await screen.findByRole("switch", { name: /Packages/i });
    expect(packages.getAttribute("aria-describedby")).toBeNull();
    await user.click(packages);
    expect(await screen.findByText("This changed on the server")).toBeTruthy();
    // The failure is announced, and the switch that reset is described by it.
    const alert = screen.getByRole("alert");
    expect(alert.id).toBe("feature-packages-error");
    expect(alert.textContent).toBe("This changed on the server");
    expect(packages.getAttribute("aria-describedby")).toBe(alert.id);
    const callsBeforeReload = packageFeeds.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() =>
      expect(packageFeeds.mock.calls.length).toBeGreaterThan(callsBeforeReload),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Reload" })).toBeNull(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(packages.getAttribute("aria-describedby")).toBeNull();
  });

  it("links a disabled Cloud Sync switch to its requirement", async () => {
    mount();
    const sync = await screen.findByRole("switch", { name: /Cloud Sync/i });
    const requirementId = sync.getAttribute("aria-describedby");
    expect(sync.getAttribute("aria-disabled")).toBe("true");
    expect(requirementId).toBe("feature-cloud-sync-requirements");
    expect(document.getElementById(requirementId!)?.textContent).toMatch(
      /Turn on Sign-in first/,
    );
  });

  it("links a disabled In-app updates switch to its requirement", async () => {
    services.mockResolvedValue(
      state({
        services: {
          ...state().services,
          release: { enabled: true },
        },
      }),
    );
    mount();
    const updates = await screen.findByRole("switch", {
      name: /In-app updates/i,
    });
    const requirementId = updates.getAttribute("aria-describedby");
    expect(updates.getAttribute("aria-disabled")).toBe("true");
    expect(requirementId).toBe(
      "feature-ship-builds-in-app-updates-requirements",
    );
    expect(document.getElementById(requirementId!)?.textContent).toMatch(
      /Turns on with Ship builds/,
    );
  });

  it("links a blocked Packages switch to why it is blocked", async () => {
    mount();
    const packages = await screen.findByRole("switch", { name: /Packages/i });
    const requirementId = packages.getAttribute("aria-describedby");
    expect((packages as HTMLButtonElement).getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(requirementId).toBe("feature-packages-requirements");
    expect(document.getElementById(requirementId!)?.textContent).toBe(
      "Turns on with Ship builds",
    );
  });

  it("marks each requirement with its own state and folds the raw slugs", async () => {
    services.mockResolvedValue(
      state({ services: { ...state().services, config: { enabled: true } } }),
    );
    mount();
    await screen.findByRole("switch", { name: /^Licensing$/i });
    expect(
      screen.getByRole("img", { name: "Managed config is on" }),
    ).toBeTruthy();
    expect(screen.getByRole("img", { name: "Sign-in is off" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Licensing is on" })).toBeTruthy();
    expect(screen.queryByText("Device registration")).toBeNull();
    const show = screen.getByRole("button", {
      name: "Show Slugs and device registration",
    });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    await userEvent.setup().click(show);
    expect(show.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Device registration")).toBeTruthy();
  });

  it("writes the Polaris Locker listing as one choice, Everyone after a confirm", async () => {
    const user = userEvent.setup();
    services.mockResolvedValue(
      state({
        services: {
          ...state().services,
          release: { enabled: true },
          distribution: { enabled: true },
          update: { enabled: true },
        },
      }),
    );
    mount();
    const group = await screen.findByRole("radiogroup", {
      name: "Polaris Locker listing",
    });
    expect(
      within(group)
        .getByRole("radio", { name: "Eligible" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await user.click(within(group).getByRole("radio", { name: "Everyone" }));
    expect(updatePortalSettings).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByRole("textbox"), "djdl");
    await user.click(
      within(dialog).getByRole("button", { name: "Show to everyone" }),
    );
    await waitFor(() =>
      expect(updatePortalSettings).toHaveBeenCalledWith("djdl", {
        storeAudience: "everyone",
        confirm: "storefront.polarisKey.audience",
      }),
    );
  });
});
