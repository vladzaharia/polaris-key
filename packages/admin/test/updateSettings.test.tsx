import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  DeliveryAccess,
  ReleaseAccess,
  UpdateSettings as UpdateSettingsDto,
  UpdateSettingsBlock,
  UpdateSettingsBody,
} from "../src/api.js";
import { resetCache } from "../src/context.js";
import { Toaster } from "../src/components/ui/index.js";

const updateSettings = vi.fn<(slug: string) => Promise<UpdateSettingsDto>>();
const saveUpdateSettings =
  vi.fn<
    (slug: string, body: UpdateSettingsBody) => Promise<UpdateSettingsDto>
  >();
const revertUpdateSettings =
  vi.fn<
    (slug: string, fields: UpdateSettingsBlock[]) => Promise<UpdateSettingsDto>
  >();
// P2b-04: Artifact access is Distribution's delivery access, on its own endpoints.
const deliveryAccess = vi.fn<(slug: string) => Promise<DeliveryAccess>>();
const saveDeliveryAccess =
  vi.fn<
    (slug: string, body: { mode: ReleaseAccess }) => Promise<DeliveryAccess>
  >();
const revertDeliveryAccess = vi.fn<(slug: string) => Promise<DeliveryAccess>>();

// `ApiError` comes through REAL: the 422 branch that turns `fields` into inline errors is guarded
// by `err instanceof ApiError`, so a stand-in class would send every rejection to the toast branch
// and the field-error case below would pass while proving nothing.
vi.mock("../src/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return {
    ...actual,
    api: {
      updateSettings: (slug: string) => updateSettings(slug),
      saveUpdateSettings: (slug: string, body: UpdateSettingsBody) =>
        saveUpdateSettings(slug, body),
      revertUpdateSettings: (slug: string, fields: UpdateSettingsBlock[]) =>
        revertUpdateSettings(slug, fields),
      deliveryAccess: (slug: string) => deliveryAccess(slug),
      saveDeliveryAccess: (slug: string, body: { mode: ReleaseAccess }) =>
        saveDeliveryAccess(slug, body),
      revertDeliveryAccess: (slug: string) => revertDeliveryAccess(slug),
    },
  };
});

const { ApiError } = await import("../src/api.js");
const { UpdateSettings } = await import("../src/views/UpdateSettings.js");

const SETTINGS: UpdateSettingsDto = {
  metadataAccess: "authenticated",
  accessSource: "manifest",
  compatMin: "1.0.0",
  compatMax: "2.0.0",
  compatSource: "manifest",
  minimumSystemVersion: null,
  requireSparkleSignature: true,
  configured: true,
};

const DELIVERY: DeliveryAccess = {
  modes: ["public", "authenticated", "licensed", "entitled"],
  app: { deliverableId: "app", mode: "licensed", source: "manifest" },
  deliverables: [],
};

function renderSettings() {
  return render(
    <Toaster>
      <UpdateSettings slug="djdl" />
    </Toaster>,
  );
}

async function pick(comboboxName: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole("combobox", { name: comboboxName }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

beforeEach(() => {
  resetCache();
  updateSettings.mockReset();
  saveUpdateSettings.mockReset();
  revertUpdateSettings.mockReset();
  updateSettings.mockResolvedValue(SETTINGS);
  saveUpdateSettings.mockResolvedValue(SETTINGS);
  revertUpdateSettings.mockResolvedValue(SETTINGS);
  deliveryAccess.mockReset();
  saveDeliveryAccess.mockReset();
  revertDeliveryAccess.mockReset();
  deliveryAccess.mockResolvedValue(DELIVERY);
  saveDeliveryAccess.mockResolvedValue(DELIVERY);
  revertDeliveryAccess.mockResolvedValue(DELIVERY);
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

describe("Update settings — feed access", () => {
  it("renders all four stored values", async () => {
    renderSettings();

    expect(
      (await screen.findByRole("combobox", { name: "Metadata access" }))
        .textContent,
    ).toContain("Authenticated");
    expect(
      (await screen.findByRole("combobox", { name: "Artifact access" }))
        .textContent,
    ).toContain("Licensed");
    expect(
      (screen.getByLabelText(/Compat min/) as HTMLInputElement).value,
    ).toBe("1.0.0");
    expect(
      (screen.getByLabelText(/Compat max/) as HTMLInputElement).value,
    ).toBe("2.0.0");
  });

  it("offers `entitled` as a selectable access mode (D-13)", async () => {
    renderSettings();
    await screen.findByRole("combobox", { name: "Metadata access" });

    await userEvent.click(
      screen.getByRole("combobox", { name: "Metadata access" }),
    );
    // D-13's whole point: `entitled` is the only mode that reads the license's OWN grants, so it
    // has to be reachable from the console rather than being a value only a manifest can set.
    expect(
      await screen.findByRole("option", { name: "Entitled" }),
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: "Public" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Authenticated" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Licensed" })).toBeTruthy();
  });

  it("sends only the access mode that changed", async () => {
    renderSettings();
    await screen.findByRole("combobox", { name: "Metadata access" });

    await pick("Metadata access", "Entitled");
    await userEvent.click(
      screen.getByRole("button", { name: "Save update settings" }),
    );

    await waitFor(() => expect(saveUpdateSettings).toHaveBeenCalledTimes(1));
    const [slug, body] = saveUpdateSettings.mock.calls[0]!;
    expect(slug).toBe("djdl");
    expect(body).toEqual({ metadataAccess: "entitled" });
    // Access modes and the compat window land in DIFFERENT tables. Resending an untouched access
    // mode at a product with no release row would 422 the request and take the compat edit with it.
    expect("artifactsAccess" in body).toBe(false);
    // …and the untouched delivery access is not claimed either.
    expect(saveDeliveryAccess).not.toHaveBeenCalled();
  });

  it("saves Artifact access to Distribution's delivery access, not update/settings (P2b-04)", async () => {
    renderSettings();
    await screen.findByRole("combobox", { name: "Artifact access" });
    await waitFor(() =>
      expect(
        screen
          .getByRole("combobox", { name: "Artifact access" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );

    await pick("Artifact access", "Entitled");
    await userEvent.click(
      screen.getByRole("button", { name: "Save update settings" }),
    );

    await waitFor(() => expect(saveDeliveryAccess).toHaveBeenCalledTimes(1));
    expect(saveDeliveryAccess.mock.calls[0]).toEqual([
      "djdl",
      { mode: "entitled" },
    ]);
    // Nothing else changed, so update/settings is not written at all.
    expect(saveUpdateSettings).not.toHaveBeenCalled();
  });

  it("keeps Artifact access disabled while the delivery access cannot be read", async () => {
    deliveryAccess.mockRejectedValue(new Error("offline"));
    renderSettings();
    const artifacts = await screen.findByRole("combobox", {
      name: "Artifact access",
    });
    expect(artifacts.hasAttribute("disabled")).toBe(true);
    expect(
      await screen.findByText(/Couldn’t load the delivery access/),
    ).toBeTruthy();
  });

  it("disables the access selects for a product with no release configuration", async () => {
    updateSettings.mockResolvedValue({ ...SETTINGS, configured: false });
    renderSettings();

    // Copy alone is not the guardrail: the server 422s a write it has nowhere to store, so the
    // control itself has to refuse, or the operator composes a change that can only fail.
    const metadata = await screen.findByRole("combobox", {
      name: "Metadata access",
    });
    expect(metadata.hasAttribute("disabled")).toBe(true);
    expect(
      screen
        .getByRole("combobox", { name: "Artifact access" })
        .hasAttribute("disabled"),
    ).toBe(true);
    await userEvent.click(metadata);
    expect(screen.queryByRole("option", { name: "Entitled" })).toBeNull();

    // …and the reason, so a disabled control is not just a dead end.
    expect(
      screen.getByText(/no release configuration/, { selector: "p" }),
    ).toBeTruthy();

    // The compat window lives on the product row, which always exists — it stays editable.
    expect(
      (screen.getByLabelText(/Compat min/) as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it("surfaces a 422's named fields inline instead of leaving the operator to guess", async () => {
    saveUpdateSettings.mockRejectedValue(new ApiError(422, ["compatMin"]));
    renderSettings();
    await screen.findByRole("combobox", { name: "Metadata access" });

    const min = screen.getByLabelText(/Compat min/);
    await userEvent.clear(min);
    await userEvent.type(min, "not-a-version");
    await userEvent.click(
      screen.getByRole("button", { name: "Save update settings" }),
    );

    // The server named one of four inputs; the console has to point at THAT one and leave the
    // other three unmarked, or the operator is back to guessing.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The server rejected this value.");
    expect(
      screen.getByLabelText(/Compat min/).getAttribute("aria-invalid"),
    ).toBe("true");
    expect(
      screen.getByLabelText(/Compat max/).hasAttribute("aria-invalid"),
    ).toBe(false);
    // …and it says so ONCE. `ServicesCard` established the split: a rejection the server
    // attributed to an input belongs beside that input, and a toast on top would put the same
    // sentence in the corner of the screen where it dismisses itself.
    expect(screen.queryByText(/Couldn.t save update settings/)).toBeNull();
  });

  it("falls back to a toast when the server attributes the failure to nothing", async () => {
    // The other half of the same rule: a 500 has no input to sit beside, so it must not vanish.
    saveUpdateSettings.mockRejectedValue(new ApiError(500, []));
    renderSettings();
    await screen.findByRole("combobox", { name: "Metadata access" });

    const min = screen.getByLabelText(/Compat min/);
    await userEvent.clear(min);
    await userEvent.type(min, "1.2.3");
    await userEvent.click(
      screen.getByRole("button", { name: "Save update settings" }),
    );

    expect(
      await screen.findByText(/Couldn.t save update settings/),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(/Compat min/).hasAttribute("aria-invalid"),
    ).toBe(false);
  });

  it("prefers the server's own sentence over the generic fallback", async () => {
    // `ApiError.message` defaults to the useless `api 422`. When the worker sends something
    // better, that is what the operator should read — the fallback exists for the default only.
    const err = new ApiError(422, ["compatMax"]);
    err.message = "compatMax must be a semver version.";
    saveUpdateSettings.mockRejectedValue(err);
    renderSettings();
    await screen.findByRole("combobox", { name: "Metadata access" });

    const max = screen.getByLabelText(/Compat max/);
    await userEvent.clear(max);
    await userEvent.type(max, "nope");
    await userEvent.click(
      screen.getByRole("button", { name: "Save update settings" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("compatMax must be a semver version.");
  });
});

describe("Update settings — the compatibility window (relocated by spec §8)", () => {
  it("round-trips a compat edit into the save body", async () => {
    // The window used to be edited beside the product's display name, which put a statement about
    // SUPPORTED BUILDS in the form for "what is this product called". It is edited here now,
    // beside the access modes it is intersected with, so this pins that it is genuinely writable
    // from this view and not merely displayed.
    renderSettings();
    await screen.findByRole("combobox", { name: "Metadata access" });

    const min = screen.getByLabelText(/Compat min/);
    const max = screen.getByLabelText(/Compat max/);
    await userEvent.clear(min);
    await userEvent.type(min, "1.4.0");
    await userEvent.clear(max);
    await userEvent.type(max, "3.0.0 ");
    await userEvent.click(
      screen.getByRole("button", { name: "Save update settings" }),
    );

    await waitFor(() => expect(saveUpdateSettings).toHaveBeenCalledTimes(1));
    const [, body] = saveUpdateSettings.mock.calls[0]!;
    // Trailing whitespace out of a paste would make the server reject a version that is otherwise
    // exactly right.
    expect(body).toEqual({ compatMin: "1.4.0", compatMax: "3.0.0" });
  });

  it("keeps save inert until a value actually differs", async () => {
    renderSettings();
    await screen.findByRole("combobox", { name: "Metadata access" });

    expect(
      screen
        .getByRole("button", { name: "Save update settings" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(saveUpdateSettings).not.toHaveBeenCalled();
  });

  it("shows an empty state with a working retry when the settings fail to load", async () => {
    updateSettings.mockReset();
    updateSettings
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValue(SETTINGS);
    renderSettings();

    expect(
      await screen.findByText("Couldn’t load update settings"),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("combobox", { name: "Metadata access" }),
    ).toBeTruthy();
  });
});

describe("Update settings — ownership (P0-01)", () => {
  it("badges each claimable block with its owner", async () => {
    updateSettings.mockResolvedValue({ ...SETTINGS, accessSource: "admin" });
    renderSettings();
    await screen.findByRole("combobox", { name: "Metadata access" });

    expect(screen.getByTestId("access-source").textContent).toBe("admin-owned");
    expect(screen.getByTestId("compat-source").textContent).toBe(
      "manifest-owned",
    );
  });

  it("only offers a revert for an admin-owned block", async () => {
    updateSettings.mockResolvedValue({ ...SETTINGS, compatSource: "admin" });
    renderSettings();
    await screen.findByRole("combobox", { name: "Metadata access" });

    expect(
      screen
        .getByRole("button", { name: "Revert feed access to manifest" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", {
          name: "Revert compatibility window to manifest",
        })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("reverts one block after confirmation, sending only that block", async () => {
    updateSettings.mockResolvedValue({
      ...SETTINGS,
      accessSource: "admin",
      compatSource: "admin",
    });
    renderSettings();
    await screen.findByRole("combobox", { name: "Metadata access" });

    await userEvent.click(
      screen.getByRole("button", { name: "Revert feed access to manifest" }),
    );
    expect(
      await screen.findByText(
        "Return the metadata access mode to the manifest?",
      ),
    ).toBeTruthy();
    expect(revertUpdateSettings).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Return to manifest" }),
    );

    await waitFor(() => expect(revertUpdateSettings).toHaveBeenCalledTimes(1));
    expect(revertUpdateSettings.mock.calls[0]).toEqual(["djdl", ["access"]]);
    // A revert is not a save: nothing else is written.
    expect(saveUpdateSettings).not.toHaveBeenCalled();
  });
});

describe("Update settings — delivery access ownership (P2b-04)", () => {
  it("badges the delivery access with its own owner and reverts it through Distribution", async () => {
    deliveryAccess.mockResolvedValue({
      ...DELIVERY,
      app: { ...DELIVERY.app, source: "admin" },
    });
    renderSettings();
    await screen.findByRole("combobox", { name: "Metadata access" });
    await waitFor(() =>
      expect(screen.getByTestId("delivery-source").textContent).toBe(
        "admin-owned",
      ),
    );
    // The metadata mode keeps its own owner.
    expect(screen.getByTestId("access-source").textContent).toBe(
      "manifest-owned",
    );

    await userEvent.click(
      screen.getByRole("button", {
        name: "Revert delivery access to manifest",
      }),
    );
    expect(
      await screen.findByText("Return the delivery access to the manifest?"),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Return to manifest" }),
    );
    await waitFor(() => expect(revertDeliveryAccess).toHaveBeenCalledTimes(1));
    expect(revertUpdateSettings).not.toHaveBeenCalled();
  });
});

describe("Update settings — operator artifact policy (P0-01)", () => {
  it("renders the stored operator policy", async () => {
    updateSettings.mockResolvedValue({
      ...SETTINGS,
      minimumSystemVersion: "13.0",
      requireSparkleSignature: false,
    });
    renderSettings();
    await screen.findByRole("combobox", { name: "Metadata access" });

    expect(
      (screen.getByLabelText(/Minimum macOS version/) as HTMLInputElement)
        .value,
    ).toBe("13.0");
    expect(
      screen
        .getByRole("switch", { name: "Require Sparkle signatures" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("sends a new minimum, and clears it to null when emptied", async () => {
    renderSettings();
    await screen.findByRole("combobox", { name: "Metadata access" });

    const min = screen.getByLabelText(/Minimum macOS version/);
    await userEvent.type(min, " 13.0 ");
    await userEvent.click(
      screen.getByRole("button", { name: "Save update settings" }),
    );
    await waitFor(() => expect(saveUpdateSettings).toHaveBeenCalledTimes(1));
    expect(saveUpdateSettings.mock.calls[0]![1]).toEqual({
      minimumSystemVersion: "13.0",
    });

    cleanup();
    resetCache();
    saveUpdateSettings.mockClear();
    updateSettings.mockResolvedValue({
      ...SETTINGS,
      minimumSystemVersion: "13.0",
    });
    renderSettings();
    await screen.findByRole("combobox", { name: "Metadata access" });
    await userEvent.clear(screen.getByLabelText(/Minimum macOS version/));
    await userEvent.click(
      screen.getByRole("button", { name: "Save update settings" }),
    );
    await waitFor(() => expect(saveUpdateSettings).toHaveBeenCalledTimes(1));
    expect(saveUpdateSettings.mock.calls[0]![1]).toEqual({
      minimumSystemVersion: null,
    });
  });

  it("asks for confirmation before turning the signature requirement off", async () => {
    renderSettings();
    await screen.findByRole("combobox", { name: "Metadata access" });

    await userEvent.click(
      screen.getByRole("switch", { name: "Require Sparkle signatures" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save update settings" }),
    );

    // Nothing is sent until the operator confirms: this weakens a security control.
    expect(
      await screen.findByText("Turn off the Sparkle signature requirement?"),
    ).toBeTruthy();
    expect(saveUpdateSettings).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", { name: "Turn off signatures" }),
    );
    await waitFor(() => expect(saveUpdateSettings).toHaveBeenCalledTimes(1));
    expect(saveUpdateSettings.mock.calls[0]![1]).toEqual({
      requireSparkleSignature: false,
    });
  });

  it("sends nothing when the confirmation is cancelled", async () => {
    renderSettings();
    await screen.findByRole("combobox", { name: "Metadata access" });

    await userEvent.click(
      screen.getByRole("switch", { name: "Require Sparkle signatures" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save update settings" }),
    );
    await screen.findByText("Turn off the Sparkle signature requirement?");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(
        screen.queryByText("Turn off the Sparkle signature requirement?"),
      ).toBeNull(),
    );
    expect(saveUpdateSettings).not.toHaveBeenCalled();
  });

  it("turns the requirement back ON without a confirmation", async () => {
    updateSettings.mockResolvedValue({
      ...SETTINGS,
      requireSparkleSignature: false,
    });
    renderSettings();
    await screen.findByRole("combobox", { name: "Metadata access" });

    await userEvent.click(
      screen.getByRole("switch", { name: "Require Sparkle signatures" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save update settings" }),
    );
    await waitFor(() => expect(saveUpdateSettings).toHaveBeenCalledTimes(1));
    expect(saveUpdateSettings.mock.calls[0]![1]).toEqual({
      requireSparkleSignature: true,
    });
  });

  it("disables the operator policy on a product with no release configuration", async () => {
    updateSettings.mockResolvedValue({ ...SETTINGS, configured: false });
    renderSettings();
    await screen.findByRole("combobox", { name: "Metadata access" });

    expect(
      (screen.getByLabelText(/Minimum macOS version/) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(
      screen
        .getByRole("switch", { name: "Require Sparkle signatures" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
