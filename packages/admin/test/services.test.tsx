import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServicesDryRun, ServicesResponse, UpdateServicesBody } from "../src/api.js";
import { ApiError } from "../src/api.js";
import { renderAt, resetCore } from "./coreTestUtils.js";
import { ServicesPage } from "../src/console/sections/core/pages/Services.js";

const services = vi.fn<(slug: string) => Promise<ServicesResponse>>();
const updateServices = vi.fn<(slug: string, body: UpdateServicesBody) => Promise<Pick<ServicesResponse, "services" | "effectiveRegistration" | "source">>>();
const revertServices = vi.fn<(slug: string) => Promise<Pick<ServicesResponse, "services" | "effectiveRegistration" | "source">>>();
const servicesDryRun = vi.fn<(slug: string, body: UpdateServicesBody) => Promise<ServicesDryRun>>();

vi.mock("../src/api.js", async () => {
  const actual = await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return { ...actual, api: { services: (slug: string) => services(slug), updateServices: (slug: string, body: UpdateServicesBody) => updateServices(slug, body), revertServices: (slug: string) => revertServices(slug), servicesDryRun: (slug: string, body: UpdateServicesBody) => servicesDryRun(slug, body), packageFeeds: async () => ({ packageFeeds: { enabled: false, version: 1 } }), savePackageFeeds: async () => ({ ok: true as const, packageFeeds: { enabled: false, version: 1 } }), portalSetting: async () => ({ settings: { portalEnabled: false } }), updatePortalSettings: async () => ({ settings: { portalEnabled: false } }) } };
});

const state = (over: Partial<ServicesResponse> = {}): ServicesResponse => ({
  services: { license: { enabled: true }, config: { enabled: true }, release: { enabled: false }, distribution: { enabled: false }, update: { enabled: false }, identity: { enabled: false }, sync: { enabled: false } },
  effectiveRegistration: "requires-license", source: "manifest",
  facts: { licensing: { tiers: 2, licenses: 3 }, managedConfig: { catalogVersion: 4 }, shipBuilds: { latest: null } }, ...over,
});
const mount = () => renderAt("#/p/djdl/settings/features", <ServicesPage slug="djdl" />);
const feature = (name: string) => screen.getByRole("switch", { name: new RegExp(name, "i") });

afterEach(cleanup);
beforeEach(() => { resetCore(); services.mockReset().mockResolvedValue(state()); updateServices.mockReset(); revertServices.mockReset(); servicesDryRun.mockReset().mockResolvedValue({ changes: [], cascaded: [], signedInDevicesToClear: 0 }); });

describe("Services feature groups", () => {
  it("renders the five generated feature controls and GET facts", async () => {
    mount();
    for (const name of ["Licensing", "Managed config", "Ship builds", "Sign-in", "Cloud Sync"]) expect(await screen.findByRole("switch", { name: new RegExp(name, "i") })).toBeTruthy();
    expect(screen.getByText(/2 tiers/)).toBeTruthy();
    expect(screen.getAllByText(/Catalog v4/)).toHaveLength(2);
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
    await user.click(await screen.findByRole("switch", { name: /Ship builds/i }));
    await waitFor(() => expect(updateServices).toHaveBeenCalledWith("djdl", { services: { release: { enabled: true }, distribution: { enabled: true }, update: { enabled: true } } }));
    expect(screen.getByText(/2 tiers/)).toBeTruthy();
  });

  it("uses the server dry run to confirm cascades before disabling", async () => {
    const user = userEvent.setup();
    services.mockResolvedValue(state({ services: { ...state().services, release: { enabled: true }, distribution: { enabled: true }, update: { enabled: true } } }));
    servicesDryRun.mockResolvedValue({ changes: [], cascaded: ["distribution", "update"], signedInDevicesToClear: 0 });
    mount();
    await user.click(await screen.findByRole("switch", { name: /Ship builds/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Also turns off Distribution and Update/)).toBeTruthy();
    expect(updateServices).not.toHaveBeenCalled();
  });

  it("shows a 422 refusal beside the requested feature", async () => {
    const user = userEvent.setup();
    updateServices.mockRejectedValue(new ApiError(422, undefined, "bad_request", ["sync_requires_identity"]));
    services.mockResolvedValue(state({ services: { ...state().services, identity: { enabled: true } } }));
    mount();
    await user.click(await screen.findByRole("switch", { name: /Cloud Sync/i }));
    expect(await screen.findByText(/Cloud Sync needs Sign-in/)).toBeTruthy();
  });
});
