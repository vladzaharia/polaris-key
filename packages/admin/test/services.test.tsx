import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServicesResponse, UpdateServicesBody } from "../src/api.js";
import { resetCache } from "../src/context.js";
import { Toaster } from "../src/components/ui/index.js";

const services = vi.fn<(slug: string) => Promise<ServicesResponse>>();
const updateServices =
  vi.fn<
    (slug: string, body: UpdateServicesBody) => Promise<ServicesResponse>
  >();
const revertServices = vi.fn<(slug: string) => Promise<ServicesResponse>>();

// `ApiError` and `SERVICE_ERROR_MESSAGES` are pulled through REAL. The card branches on
// `err instanceof ApiError` to decide inline-vs-toast, so a hand-rolled stand-in class would make
// every rejection fall through to the toast branch and the guardrail cases below would pass while
// asserting nothing. Same for the copy table: mapping a code to a message is the behaviour under
// test, not a fixture.
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
const { Services } = await import("../src/views/Services.js");

/**
 * A product running everything except Config, riding the DERIVED registration policy
 * (`registration: null`) — the default a manifest that says nothing produces.
 */
const ALL_ON: ServicesResponse = {
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
  source: "manifest",
};

/** `ALL_ON` with a few flags moved — the enablement map merges rather than replaces. */
function state(
  over: Partial<Omit<ServicesResponse, "services">> & {
    services?: Partial<ServicesResponse["services"]>;
  } = {},
): ServicesResponse {
  return {
    ...ALL_ON,
    ...over,
    services: { ...ALL_ON.services, ...(over.services ?? {}) },
  };
}

function renderServices() {
  return render(
    <Toaster>
      <Services slug="djdl" />
    </Toaster>,
  );
}

/** The switch for a service row, addressed the way an operator addresses it. */
function toggle(name: string): HTMLElement {
  return screen.getByRole("switch", { name });
}

function checked(el: HTMLElement): boolean {
  return el.getAttribute("aria-checked") === "true";
}

beforeEach(() => {
  resetCache();
  services.mockReset();
  updateServices.mockReset();
  revertServices.mockReset();
  services.mockResolvedValue(ALL_ON);
  updateServices.mockResolvedValue(ALL_ON);
  revertServices.mockResolvedValue(state({ source: "manifest" }));
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

describe("Services — what the product runs", () => {
  it("renders all five services with their enabled state, the owner badge, and a derived registration policy", async () => {
    renderServices();

    // All five of D-15's opt-in services, each showing what the server said — not a default.
    //
    // Wait for the SETTLED value, not merely for the switch to exist. The card seeds its draft
    // from the response in an effect, so there is exactly one committed render where the five
    // switches are in the DOM at their initial all-off state; `findByRole` can resolve on that
    // render when the machine is busy, and this assertion then reads a frame that never reaches
    // an operator's eye.
    await waitFor(() => expect(checked(toggle("License"))).toBe(true));
    expect(checked(toggle("Config"))).toBe(false);
    expect(checked(toggle("Release"))).toBe(true);
    expect(checked(toggle("Update"))).toBe(true);
    expect(checked(toggle("Identity"))).toBe(true);

    // `source` decides whether a resync may overwrite this row, so it is stated rather than left
    // for the operator to discover when their change vanishes on the next push.
    expect(screen.getByText("manifest-owned")).toBeTruthy();

    // `registration: null` is not "open" — it means the product rides the derivation, and the
    // card has to say so, because the enforced value can change without anyone editing this row.
    // Scoped to the declared/enforced list: every policy name also appears in the help paragraph
    // that explains the derivation, so an unscoped match would pass on the prose alone.
    const policies = screen.getByText("Enforced now:").closest("dl")!;
    expect(within(policies).getByText("derived")).toBeTruthy();
    expect(within(policies).getByText("requires-license")).toBeTruthy();
  });

  it("names the declared policy instead of the derived affordance once one is set", async () => {
    services.mockResolvedValue(state({ registration: "open" }));
    renderServices();

    await screen.findByRole("switch", { name: "License" });
    // Declared and enforced are separate facts; only the absence of a declaration reads "derived".
    const policies = screen.getByText("Enforced now:").closest("dl")!;
    expect(within(policies).queryByText("derived")).toBeNull();
    expect(within(policies).getByText("open")).toBeTruthy();
  });

  it("sends only the services it knows about, leaving an unrecognised slug untouched", async () => {
    // A worker one release ahead of this console: it runs a sixth service the card has never
    // heard of. The PATCH body is keyed on what the card DREW, so the unknown slug is omitted and
    // the server keeps its current value — an older console cannot silently switch off a service
    // it cannot render.
    services.mockResolvedValue({
      ...ALL_ON,
      services: {
        ...ALL_ON.services,
        analytics: { enabled: true },
      } as ServicesResponse["services"],
    });
    renderServices();
    await screen.findByRole("switch", { name: "License" });

    await userEvent.click(toggle("Update"));
    // The set is validated as a whole server-side, so the card batches: nothing is sent until the
    // operator says they are done composing the change.
    expect(updateServices).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", { name: "Save services" }),
    );
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
    // Exactly one flag moved; every other slug is echoed at the value the GET reported.
    expect(body.services).toMatchObject({
      license: { enabled: true },
      config: { enabled: false },
      release: { enabled: true },
      distribution: { enabled: true },
      update: { enabled: false },
      identity: { enabled: true },
    });
    // An undeclared policy stays undeclared — a save must not quietly freeze the derivation.
    expect(body.registration).toBeNull();
  });

  it("renders a coherence rejection beside the switch it indicts, not as a toast", async () => {
    services.mockResolvedValue(
      state({
        services: {
          release: { enabled: false },
          distribution: { enabled: false },
          update: { enabled: false },
        },
      }),
    );
    updateServices.mockRejectedValue(
      new ApiError(422, undefined, "bad_request", [
        "update_requires_distribution",
      ]),
    );
    renderServices();
    await screen.findByRole("switch", { name: "License" });

    await userEvent.click(toggle("Update"));
    await userEvent.click(
      screen.getByRole("button", { name: "Save services" }),
    );

    // The mapped copy — not the raw code — is what the operator reads.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      SERVICE_ERROR_MESSAGES.update_requires_distribution,
    );
    // …and it is bound to the control at fault, so a screen reader reaches it from the switch
    // rather than having to find a sentence floating elsewhere on the page.
    expect(toggle("Update").getAttribute("aria-invalid")).toBe("true");
    expect(toggle("Distribution").hasAttribute("aria-invalid")).toBe(false);
    expect(toggle("Release").hasAttribute("aria-invalid")).toBe(false);

    // A toast would dismiss itself and sit in the corner, away from the switch that was just
    // moved. The card must NOT have fallen back to one.
    expect(screen.queryByText(/Couldn.t update services/)).toBeNull();
  });

  it("points registration_requires_identity at both halves of the relationship", async () => {
    // This code names a RELATIONSHIP, not an input: the declared policy and the Identity switch
    // are each individually fine and jointly impossible, so the message belongs on both.
    services.mockResolvedValue(state({ registration: "requires-identity" }));
    updateServices.mockRejectedValue(
      new ApiError(422, undefined, "bad_request", [
        "registration_requires_identity",
      ]),
    );
    renderServices();
    await screen.findByRole("switch", { name: "License" });

    await userEvent.click(toggle("Identity"));
    await userEvent.click(
      screen.getByRole("button", { name: "Save services" }),
    );

    await waitFor(() =>
      expect(
        screen.getAllByText(
          SERVICE_ERROR_MESSAGES.registration_requires_identity!,
        ).length,
      ).toBeGreaterThan(0),
    );
    expect(toggle("Identity").getAttribute("aria-invalid")).toBe("true");
    expect(
      screen
        .getByRole("combobox", { name: "Device registration policy" })
        .getAttribute("aria-invalid"),
    ).toBe("true");
    expect(screen.queryByText(/Couldn.t update services/)).toBeNull();
  });

  it("clears a rejection as soon as the operator changes the set it was about", async () => {
    services.mockResolvedValue(
      state({
        services: {
          release: { enabled: false },
          distribution: { enabled: false },
          update: { enabled: false },
        },
      }),
    );
    updateServices.mockRejectedValue(
      new ApiError(422, undefined, "bad_request", [
        "update_requires_distribution",
      ]),
    );
    renderServices();
    await screen.findByRole("switch", { name: "License" });

    await userEvent.click(toggle("Update"));
    await userEvent.click(
      screen.getByRole("button", { name: "Save services" }),
    );
    await screen.findByRole("alert");

    // The verdict was on one specific proposed set. Turning Distribution on is the operator
    // answering it; leaving the sentence up would have them reading a judgement they already
    // withdrew.
    await userEvent.click(toggle("Distribution"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("states the P1.7 revert semantics before handing the row back to the manifest", async () => {
    services.mockResolvedValue(state({ source: "admin" }));
    renderServices();
    await screen.findByRole("switch", { name: "License" });

    await userEvent.click(
      screen.getByRole("button", { name: /Revert to manifest/ }),
    );
    const dialog = await screen.findByRole("alertdialog");

    // The two facts an operator gets wrong without being told: nothing changes now, and the
    // manifest's values land on the NEXT resync rather than being fetched here.
    expect(within(dialog).getByText(/changes NOTHING live/)).toBeTruthy();
    expect(within(dialog).getByText(/next resync/)).toBeTruthy();
    expect(revertServices).not.toHaveBeenCalled();

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Return to manifest" }),
    );
    await waitFor(() => expect(revertServices).toHaveBeenCalledWith("djdl"));
  });

  it("offers no revert for a row the manifest already owns", async () => {
    // Reverting a manifest-owned row is a no-op the server would accept, so the only signal the
    // operator gets is the button doing nothing. Gate it instead.
    renderServices();
    await screen.findByRole("switch", { name: "License" });

    const button = screen.getByRole("button", { name: /Revert to manifest/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    await userEvent.click(button);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows an empty state with a working retry when the service set fails to load", async () => {
    services.mockReset();
    services
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue(ALL_ON);
    renderServices();

    expect(await screen.findByText("Couldn’t load services")).toBeTruthy();
    expect(screen.getByText("network down")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("switch", { name: "License" })).toBeTruthy();
  });
});
