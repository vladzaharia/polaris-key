import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServicesResponse, UpdateServicesBody } from "../src/api.js";
import { expectNoAxeViolations, renderAt, resetCore } from "./coreTestUtils.js";

const services = vi.fn<(slug: string) => Promise<ServicesResponse>>();
const updateServices =
  vi.fn<
    (slug: string, body: UpdateServicesBody) => Promise<ServicesResponse>
  >();
const revertServices = vi.fn<(slug: string) => Promise<ServicesResponse>>();

// `ApiError` and `SERVICE_ERROR_MESSAGES` stay REAL: the page branches on `instanceof ApiError`.
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
    },
  };
});

const { ApiError, SERVICE_ERROR_MESSAGES } = await import("../src/api.js");
const { ServicesPage } = await import("../src/console/pages/core/Services.js");

/** Everything but Config, on the derived registration policy. */
function state(over: Partial<ServicesResponse> = {}): ServicesResponse {
  return {
    services: {
      license: { enabled: true },
      config: { enabled: false },
      release: { enabled: true },
      distribution: { enabled: true },
      update: { enabled: true },
      identity: { enabled: true },
    },
    registration: null,
    effectiveRegistration: "requires-license",
    source: "admin",
    ...over,
  };
}

const mount = () => renderAt("#/p/djdl/services", <ServicesPage slug="djdl" />);
const sw = (name: string) =>
  screen.getByRole("switch", { name: new RegExp(name) });

beforeEach(() => {
  resetCore();
  services.mockReset().mockResolvedValue(state());
  updateServices.mockReset();
  revertServices.mockReset();
});
afterEach(cleanup);

describe("Core → Services", () => {
  it("shows a loading state, then all six services with their state, owner and the derived policy", async () => {
    let resolve!: (v: ServicesResponse) => void;
    services.mockReturnValue(new Promise((r) => (resolve = r)));
    mount();
    expect(
      screen.getByRole("heading", { level: 1, name: "Services" }),
    ).toBeTruthy();
    expect(screen.getByText("Loading services…")).toBeTruthy();
    resolve(state());
    await screen.findByRole("switch", { name: /License/ });
    for (const s of [
      "License",
      "Release",
      "Distribution",
      "Update",
      "Identity",
    ])
      expect(sw(s).getAttribute("aria-checked")).toBe("true");
    expect(sw("Config").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Set in console")).toBeTruthy();
    expect(
      screen
        .getByRole("radio", { name: /Derived from services/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    // One h1 only (SVC-7).
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("scopes each row to its own section accent (SVC-4)", async () => {
    mount();
    await screen.findByRole("switch", { name: /License/ });
    const row = sw("Distribution").closest("[data-service]");
    expect(row?.getAttribute("data-service")).toBe("distribution");
  });

  it("names a declared policy in words, never the raw slug (SVC-5)", async () => {
    services.mockResolvedValue(
      state({
        registration: "requires-identity",
        effectiveRegistration: "requires-identity",
      }),
    );
    mount();
    const radio = await screen.findByRole("radio", {
      name: /Identity required/,
    });
    expect(radio.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("requires-identity")).toBeNull();
  });

  it("names dependencies before any save, and fixes a broken edge in one click (SVC-1)", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("switch", { name: /Release/ });
    expect(screen.getAllByText("Requires Release.").length).toBeGreaterThan(0);
    await user.click(sw("Release"));
    const msg = SERVICE_ERROR_MESSAGES.distribution_requires_release!;
    expect((await screen.findAllByText(msg)).length).toBeGreaterThan(0);
    await user.click(
      screen.getAllByRole("button", { name: "Turn on Release" })[0]!,
    );
    expect(sw("Release").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryAllByText(msg)).toHaveLength(0);
  });

  it("saves the whole set through the save bar, marking changed rows (SVC-3)", async () => {
    const user = userEvent.setup();
    updateServices.mockResolvedValue(state());
    mount();
    await screen.findByRole("switch", { name: /Config/ });
    await user.click(sw("Config"));
    expect(screen.getByText("Changed")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save services" }));
    await waitFor(() => expect(updateServices).toHaveBeenCalledTimes(1));
    expect(updateServices.mock.calls[0]).toEqual([
      "djdl",
      {
        services: {
          license: { enabled: true },
          config: { enabled: true },
          release: { enabled: true },
          distribution: { enabled: true },
          update: { enabled: true },
          identity: { enabled: true },
        },
        registration: null,
      },
    ]);
    // The mutation's invalidation refetches the set.
    await waitFor(() => expect(services.mock.calls.length).toBeGreaterThan(1));
  });

  it("sends only the services it knows about, leaving an unrecognised slug untouched", async () => {
    // A Worker one release ahead of this console runs a seventh service the page has never heard
    // of. The PATCH body is keyed on the services the page draws, so the unknown slug is omitted
    // and the server keeps its value: an older console cannot switch off a service it cannot show.
    const user = userEvent.setup();
    services.mockResolvedValue(
      state({
        services: {
          ...state().services,
          analytics: { enabled: true },
        } as ServicesResponse["services"],
      }),
    );
    updateServices.mockResolvedValue(state());
    mount();
    await screen.findByRole("switch", { name: /Config/ });
    expect(screen.queryByRole("switch", { name: /analytics/i })).toBeNull();
    await user.click(sw("Config"));
    // The set is validated as a whole server-side: nothing is sent until Save.
    expect(updateServices).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save services" }));
    await waitFor(() => expect(updateServices).toHaveBeenCalledTimes(1));
    const [slug, body] = updateServices.mock.calls[0]!;
    expect(slug).toBe("djdl");
    expect(Object.keys(body.services ?? {}).sort()).toEqual([
      "config",
      "distribution",
      "identity",
      "license",
      "release",
      "update",
    ]);
    // Exactly one flag moved; every other known slug is echoed at the value the GET reported.
    expect(body.services).toEqual({
      license: { enabled: true },
      config: { enabled: true },
      release: { enabled: true },
      distribution: { enabled: true },
      update: { enabled: true },
      identity: { enabled: true },
    });
    // An undeclared policy stays undeclared: a save must not freeze the derivation.
    expect(body.registration).toBeNull();
  });

  it("asks before turning a service off (L1), and a cancel saves nothing (SVC-2)", async () => {
    const user = userEvent.setup();
    updateServices.mockResolvedValue(state());
    mount();
    await screen.findByRole("switch", { name: /Identity/ });
    await user.click(sw("Identity"));
    await user.click(screen.getByRole("button", { name: "Save services" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Turn off Identity?")).toBeTruthy();
    expect(
      within(dialog).getByText(
        /Product sign-in and the customer portal stop working/,
      ),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(updateServices).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save services" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Turn off Identity",
      }),
    );
    await waitFor(() => expect(updateServices).toHaveBeenCalledTimes(1));
    expect(updateServices.mock.calls[0]![1].services!.identity).toEqual({
      enabled: false,
    });
  });

  it("renders a server coherence rejection beside the controls it indicts, and clears it when the set changes", async () => {
    const user = userEvent.setup();
    updateServices.mockRejectedValue(
      new ApiError(422, undefined, "bad_request", [
        "registration_requires_identity",
      ]),
    );
    mount();
    await screen.findByRole("switch", { name: /Config/ });
    await user.click(sw("Config"));
    await user.click(screen.getByRole("button", { name: "Save services" }));
    const msg = SERVICE_ERROR_MESSAGES.registration_requires_identity!;
    // Both halves: the Identity row and the registration row.
    await waitFor(() => expect(screen.getAllByText(msg)).toHaveLength(2));
    await user.click(sw("Config"));
    expect(screen.queryAllByText(msg)).toHaveLength(0);
  });

  it("states what reverting to the manifest does before doing it", async () => {
    const user = userEvent.setup();
    revertServices.mockResolvedValue(state({ source: "manifest" }));
    mount();
    await user.click(
      await screen.findByRole("button", { name: "Revert to manifest…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Nothing changes now/)).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", { name: "Revert to manifest" }),
    );
    await waitFor(() => expect(revertServices).toHaveBeenCalledWith("djdl"));
  });

  it("offers no revert for a set the manifest already owns", async () => {
    services.mockResolvedValue(state({ source: "manifest" }));
    mount();
    const button = await screen.findByRole("button", {
      name: /Revert to manifest/,
    });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("From manifest")).toBeTruthy();
  });

  it("shows an error state with a working retry", async () => {
    const user = userEvent.setup();
    services.mockRejectedValueOnce(new ApiError(500));
    mount();
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("switch", { name: /License/ })).toBeTruthy();
  });

  it("passes axe", async () => {
    const { container } = mount();
    await screen.findByRole("switch", { name: /License/ });
    await expectNoAxeViolations(container);
  });
});
