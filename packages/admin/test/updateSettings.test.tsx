import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  UpdateSettings as UpdateSettingsDto,
  UpdateSettingsBody,
} from "../src/api.js";
import { resetCache } from "../src/context.js";
import { Toaster } from "../src/components/ui/index.js";

const updateSettings = vi.fn<(slug: string) => Promise<UpdateSettingsDto>>();
const saveUpdateSettings =
  vi.fn<
    (slug: string, body: UpdateSettingsBody) => Promise<UpdateSettingsDto>
  >();

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
    },
  };
});

const { ApiError } = await import("../src/api.js");
const { UpdateSettings } = await import("../src/views/UpdateSettings.js");

const SETTINGS: UpdateSettingsDto = {
  metadataAccess: "authenticated",
  artifactsAccess: "licensed",
  compatMin: "1.0.0",
  compatMax: "2.0.0",
  configured: true,
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
  updateSettings.mockResolvedValue(SETTINGS);
  saveUpdateSettings.mockResolvedValue(SETTINGS);
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
      screen.getByRole("combobox", { name: "Artifact access" }).textContent,
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
