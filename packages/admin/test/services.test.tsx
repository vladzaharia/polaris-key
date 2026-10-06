import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServicesResponse, UpdateServicesBody } from "../src/api.js";
import { expectNoAxeViolations, renderAt, resetCore } from "./coreTestUtils.js";

const services = vi.fn<(slug: string) => Promise<ServicesResponse>>();
const updateServices =
  vi.fn<
    (slug: string, body: UpdateServicesBody) => Promise<ServicesResponse>
  >();
const revertServices = vi.fn<(slug: string) => Promise<ServicesResponse>>();
type Feeds = { enabled: boolean; version: number };
const packageFeeds =
  vi.fn<(slug: string) => Promise<{ packageFeeds: Feeds }>>();
const savePackageFeeds =
  vi.fn<
    (
      slug: string,
      body: { enabled: boolean; expectedVersion: number },
    ) => Promise<{ ok: true; packageFeeds: Feeds }>
  >();

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
      packageFeeds: (slug: string) => packageFeeds(slug),
      savePackageFeeds: (
        slug: string,
        body: { enabled: boolean; expectedVersion: number },
      ) => savePackageFeeds(slug, body),
    },
  };
});

const { ApiError, SERVICE_ERROR_MESSAGES } = await import("../src/api.js");
const { ServicesPage, chainFlip, dependentsOf, needsOf } =
  await import("../src/console/pages/core/Services.js");

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
      sync: { enabled: false },
    },
    registration: null,
    effectiveRegistration: "requires-license",
    source: "admin",
    ...over,
  };
}

/** `state()` with some services moved. */
function withServices(
  over: Partial<Record<keyof ServicesResponse["services"], boolean>>,
  rest: Partial<ServicesResponse> = {},
): ServicesResponse {
  const base = state(rest);
  const services = { ...base.services };
  for (const [k, v] of Object.entries(over))
    (services as Record<string, { enabled: boolean }>)[k] = { enabled: v! };
  return { ...base, services };
}

const ALL_ON = {
  license: true,
  config: true,
  release: true,
  distribution: true,
  update: true,
  identity: true,
  sync: true,
};
const CHAIN_OFF = { release: false, distribution: false, update: false };

const mount = () => renderAt("#/p/djdl/services", <ServicesPage slug="djdl" />);
const sw = (name: string) =>
  screen.getByRole("switch", { name: new RegExp(name) });

beforeEach(() => {
  resetCore();
  services.mockReset().mockResolvedValue(state());
  updateServices.mockReset();
  revertServices.mockReset();
  packageFeeds
    .mockReset()
    .mockResolvedValue({ packageFeeds: { enabled: false, version: 3 } });
  savePackageFeeds.mockReset();
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

  it("derives the chain from the generated edges: what X needs, and what needs X", () => {
    expect(needsOf("update")).toEqual(["distribution", "release"]);
    expect(needsOf("release")).toEqual([]);
    expect(dependentsOf("release")).toEqual(["distribution", "update"]);
    expect(dependentsOf("update")).toEqual([]);
    const off = { ...ALL_ON, ...CHAIN_OFF };
    // Turning on X turns on what X needs, and nothing more.
    expect(chainFlip("update", true, off)).toEqual([
      "update",
      "distribution",
      "release",
    ]);
    expect(chainFlip("release", true, off)).toEqual(["release"]);
    expect(chainFlip("update", true, { ...off, release: true })).toEqual([
      "update",
      "distribution",
    ]);
    // Turning off X takes what needs X with it.
    expect(chainFlip("release", false, ALL_ON)).toEqual([
      "release",
      "distribution",
      "update",
    ]);
    expect(chainFlip("update", false, ALL_ON)).toEqual(["update"]);
  });

  it("derives the Cloud Sync edges: it needs Config and Identity, and goes with either (U-04)", () => {
    expect(needsOf("sync")).toEqual(["config", "identity"]);
    expect(dependentsOf("config")).toEqual(["sync"]);
    expect(dependentsOf("identity")).toEqual(["sync"]);
    expect(chainFlip("identity", false, ALL_ON)).toEqual(["identity", "sync"]);
    expect(chainFlip("config", false, ALL_ON)).toEqual(["config", "sync"]);
    // With Cloud Sync off, Identity goes alone.
    expect(chainFlip("identity", false, { ...ALL_ON, sync: false })).toEqual([
      "identity",
    ]);
  });

  it("turning on Cloud Sync from all-off turns on Config and Identity with it, sending only those flags (U-04)", async () => {
    const user = userEvent.setup();
    const allOff = { config: false, identity: false, sync: false };
    services.mockResolvedValue(withServices(allOff));
    updateServices.mockImplementationOnce(async () => {
      const on = withServices({ config: true, identity: true, sync: true });
      services.mockResolvedValue(on);
      return on;
    });
    mount();
    await screen.findByRole("switch", { name: /Cloud Sync/ });
    expect(screen.getByText("Needs Config and Identity.")).toBeTruthy();
    await user.click(sw("Cloud Sync"));
    await waitFor(() => expect(updateServices).toHaveBeenCalledTimes(1));
    expect(updateServices.mock.calls[0]).toEqual([
      "djdl",
      {
        services: {
          sync: { enabled: true },
          config: { enabled: true },
          identity: { enabled: true },
        },
      },
    ]);
    expect(await screen.findByText("Cloud Sync turned on")).toBeTruthy();
    expect(
      screen.getByText("Also turned on Config and Identity."),
    ).toBeTruthy();
    for (const s of ["Cloud Sync", "Config", "Identity"])
      expect(sw(s).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  for (const [name, slug] of [
    ["Identity", "identity"],
    ["Config", "config"],
  ] as const) {
    it(`turning off ${name} while Cloud Sync is on lists Cloud Sync in the confirm and takes it off (U-04)`, async () => {
      const user = userEvent.setup();
      services.mockResolvedValue(withServices({ config: true, sync: true }));
      updateServices.mockImplementationOnce(async () => {
        const off = withServices({ config: true, [slug]: false, sync: false });
        services.mockResolvedValue(off);
        return off;
      });
      mount();
      await screen.findByRole("switch", { name: new RegExp(name) });
      await user.click(sw(name));
      const dialog = await screen.findByRole("alertdialog");
      expect(within(dialog).getByText(`Turn off ${name}?`)).toBeTruthy();
      expect(
        within(dialog).getByText("Also turns off Cloud Sync, which needs it."),
      ).toBeTruthy();
      await user.click(
        within(dialog).getByRole("button", { name: "Turn off 2 services" }),
      );
      await waitFor(() => expect(updateServices).toHaveBeenCalledTimes(1));
      expect(updateServices.mock.calls[0]![1]).toEqual({
        services: { [slug]: { enabled: false }, sync: { enabled: false } },
      });
      expect(
        await screen.findByText("Cloud Sync turned off with it."),
      ).toBeTruthy();
      await waitFor(() =>
        expect(sw("Cloud Sync").getAttribute("aria-checked")).toBe("false"),
      );
    });
  }

  it("turning on Update also turns on Distribution and Release, saves at once, and offers undo (L0)", async () => {
    const user = userEvent.setup();
    services.mockResolvedValue(withServices(CHAIN_OFF));
    updateServices.mockImplementationOnce(async () => {
      services.mockResolvedValue(withServices({}));
      return withServices({});
    });
    mount();
    await screen.findByRole("switch", { name: /Update/ });
    // Each row states what it needs before anything moves.
    expect(screen.getByText("Needs Distribution and Release.")).toBeTruthy();
    await user.click(sw("Update"));
    await waitFor(() => expect(updateServices).toHaveBeenCalledTimes(1));
    // Only the flipped flags travel; the policy is not part of a switch's write.
    expect(updateServices.mock.calls[0]).toEqual([
      "djdl",
      {
        services: {
          update: { enabled: true },
          distribution: { enabled: true },
          release: { enabled: true },
        },
      },
    ]);
    expect(await screen.findByText("Update turned on")).toBeTruthy();
    expect(
      screen.getByText("Also turned on Distribution and Release."),
    ).toBeTruthy();
    for (const s of ["Update", "Distribution", "Release"])
      expect(sw(s).getAttribute("aria-checked")).toBe("true");
    // No confirm for turning on, and no services save bar.
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save services" })).toBeNull();

    updateServices.mockResolvedValueOnce(withServices(CHAIN_OFF));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(updateServices).toHaveBeenCalledTimes(2));
    expect(updateServices.mock.calls[1]![1]).toEqual({
      services: {
        update: { enabled: false },
        distribution: { enabled: false },
        release: { enabled: false },
      },
    });
  });

  it("turning on Release turns on nothing else", async () => {
    const user = userEvent.setup();
    services.mockResolvedValue(withServices(CHAIN_OFF));
    updateServices.mockResolvedValue(
      withServices({ distribution: false, update: false }),
    );
    mount();
    await screen.findByRole("switch", { name: /Release/ });
    await user.click(sw("Release"));
    await waitFor(() => expect(updateServices).toHaveBeenCalledTimes(1));
    expect(updateServices.mock.calls[0]![1]).toEqual({
      services: { release: { enabled: true } },
    });
    expect(await screen.findByText("Release turned on")).toBeTruthy();
    expect(screen.queryByText(/Also turned on/)).toBeNull();
    expect(sw("Distribution").getAttribute("aria-checked")).toBe("false");
  });

  it("sends only the flags it flips, leaving an unrecognised slug untouched", async () => {
    // A Worker one release ahead of this console runs a seventh service the page has never heard
    // of. The PATCH merges, and a switch sends only what it flips: an older console cannot switch
    // off a service it cannot show, nor freeze an undeclared policy.
    const user = userEvent.setup();
    services.mockResolvedValue(
      state({
        services: {
          ...state().services,
          analytics: { enabled: true },
        } as ServicesResponse["services"],
      }),
    );
    updateServices.mockResolvedValue(withServices({ config: true }));
    mount();
    await screen.findByRole("switch", { name: /Config/ });
    expect(screen.queryByRole("switch", { name: /analytics/i })).toBeNull();
    await user.click(sw("Config"));
    await waitFor(() => expect(updateServices).toHaveBeenCalledTimes(1));
    const [slug, body] = updateServices.mock.calls[0]!;
    expect(slug).toBe("djdl");
    expect(body).toEqual({ services: { config: { enabled: true } } });
    expect("registration" in body).toBe(false);
  });

  it("asks before turning a service off (L1), listing what goes with it; a cancel saves nothing (SVC-2)", async () => {
    const user = userEvent.setup();
    updateServices.mockResolvedValue(withServices(CHAIN_OFF));
    mount();
    await screen.findByRole("switch", { name: /Release/ });
    await user.click(sw("Release"));
    let dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Turn off Release?")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Also turns off Distribution and Update, which need it.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/The update feed answers not-configured/),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(updateServices).not.toHaveBeenCalled();
    expect(sw("Release").getAttribute("aria-checked")).toBe("true");

    await user.click(sw("Release"));
    dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Turn off 3 services" }),
    );
    await waitFor(() => expect(updateServices).toHaveBeenCalledTimes(1));
    expect(updateServices.mock.calls[0]![1]).toEqual({
      services: {
        release: { enabled: false },
        distribution: { enabled: false },
        update: { enabled: false },
      },
    });
    expect(await screen.findByText("Release turned off")).toBeTruthy();
    expect(
      screen.getByText("Distribution and Update turned off with it."),
    ).toBeTruthy();
  });

  it("turning off a service nothing needs confirms that one alone", async () => {
    const user = userEvent.setup();
    updateServices.mockResolvedValue(withServices({ identity: false }));
    mount();
    await screen.findByRole("switch", { name: /Identity/ });
    await user.click(sw("Identity"));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Turn off Identity?")).toBeTruthy();
    expect(within(dialog).queryByText(/Also turns off/)).toBeNull();
    expect(
      within(dialog).getByText(
        /Product sign-in and the customer portal stop working/,
      ),
    ).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", { name: "Turn off Identity" }),
    );
    await waitFor(() =>
      expect(updateServices.mock.calls[0]![1]).toEqual({
        services: { identity: { enabled: false } },
      }),
    );
  });

  it("refuses a flip the registration policy forbids before asking or sending", async () => {
    const user = userEvent.setup();
    services.mockResolvedValue(
      state({
        registration: "requires-identity",
        effectiveRegistration: "requires-identity",
      }),
    );
    mount();
    await screen.findByRole("switch", { name: /Identity/ });
    await user.click(sw("Identity"));
    const msg = SERVICE_ERROR_MESSAGES.registration_requires_identity!;
    // Both halves: the Identity row and the registration row.
    await waitFor(() => expect(screen.getAllByText(msg)).toHaveLength(2));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(updateServices).not.toHaveBeenCalled();
    expect(sw("Identity").getAttribute("aria-checked")).toBe("true");
  });

  it("renders a server coherence rejection beside the controls it indicts, and clears it when the policy moves", async () => {
    const user = userEvent.setup();
    updateServices.mockRejectedValue(
      new ApiError(422, undefined, "bad_request", [
        "registration_requires_identity",
      ]),
    );
    mount();
    await screen.findByRole("switch", { name: /Config/ });
    await user.click(sw("Config"));
    const msg = SERVICE_ERROR_MESSAGES.registration_requires_identity!;
    await waitFor(() => expect(screen.getAllByText(msg)).toHaveLength(2));
    // The refused flip did not stick.
    expect(sw("Config").getAttribute("aria-checked")).toBe("false");
    await user.click(screen.getByRole("radio", { name: /Open/ }));
    expect(screen.queryAllByText(msg)).toHaveLength(0);
  });

  it("saves the registration policy through its own section save, sending only the policy", async () => {
    const user = userEvent.setup();
    updateServices.mockResolvedValue(
      state({ registration: "open", effectiveRegistration: "open" }),
    );
    mount();
    await screen.findByRole("radio", { name: /Open/ });
    await user.click(screen.getByRole("radio", { name: /Open/ }));
    expect(screen.getByText(/After saving/)).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Save registration policy" }),
    );
    await waitFor(() => expect(updateServices).toHaveBeenCalledTimes(1));
    expect(updateServices.mock.calls[0]).toEqual([
      "djdl",
      { registration: "open" },
    ]);
    expect(await screen.findByText("Registration policy saved")).toBeTruthy();
  });

  it("package feeds save on their own: on at once with undo, off behind a confirm", async () => {
    const user = userEvent.setup();
    // The server moves with each write, so the invalidation's refetch agrees with it.
    savePackageFeeds.mockImplementation(async (_slug, body) => {
      const next = {
        enabled: body.enabled,
        version: body.expectedVersion + 1,
      };
      packageFeeds.mockResolvedValue({ packageFeeds: next });
      return { ok: true, packageFeeds: next };
    });
    mount();
    const feeds = await screen.findByRole("switch", { name: /Package feeds/ });
    await waitFor(() => expect(feeds.getAttribute("aria-readonly")).toBeNull());
    await user.click(feeds);
    await waitFor(() =>
      expect(savePackageFeeds).toHaveBeenCalledWith("djdl", {
        enabled: true,
        expectedVersion: 3,
      }),
    );
    expect(await screen.findByText("Package feeds turned on")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Save package feeds" }),
    ).toBeNull();
    // Undo carries the version the save returned, not the one the page first read.
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(savePackageFeeds).toHaveBeenLastCalledWith("djdl", {
        enabled: false,
        expectedVersion: 4,
      }),
    );
    await waitFor(() =>
      expect(feeds.getAttribute("aria-checked")).toBe("false"),
    );
    await waitFor(() => expect(feeds.getAttribute("aria-readonly")).toBeNull());
    await user.click(feeds);
    await waitFor(() =>
      expect(feeds.getAttribute("aria-checked")).toBe("true"),
    );
    await waitFor(() => expect(feeds.getAttribute("aria-readonly")).toBeNull());
    const calls = savePackageFeeds.mock.calls.length;
    await user.click(feeds);
    const dialog = await screen.findByRole("alertdialog");
    expect(savePackageFeeds.mock.calls.length).toBe(calls);
    await user.click(
      within(dialog).getByRole("button", { name: "Turn off package feeds" }),
    );
    await waitFor(() =>
      expect(savePackageFeeds).toHaveBeenLastCalledWith("djdl", {
        enabled: false,
        expectedVersion: 6,
      }),
    );
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
    expect(await screen.findByText("From manifest")).toBeTruthy();
    // Nothing to revert: the action is absent, not a dead button.
    expect(
      screen.queryByRole("button", { name: /Revert to manifest/ }),
    ).toBeNull();
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
