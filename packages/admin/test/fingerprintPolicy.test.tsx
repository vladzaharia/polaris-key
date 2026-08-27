import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  FingerprintPolicyDto,
  FingerprintPolicyResponse,
  ServicesResponse,
} from "../src/api.js";
import { resetCache } from "../src/context.js";
import { Toaster } from "../src/components/ui/index.js";

const fingerprintPolicy =
  vi.fn<(slug: string) => Promise<FingerprintPolicyResponse>>();
const updateFingerprintPolicy =
  vi.fn<
    (
      slug: string,
      patch: Partial<FingerprintPolicyDto>,
    ) => Promise<FingerprintPolicyResponse>
  >();
const revertFingerprintPolicy =
  vi.fn<(slug: string) => Promise<FingerprintPolicyResponse>>();
// The enrollment half of this view is a read-only projection of the SERVICE set, so the suite has
// to answer this call even though nothing here can write it.
const services = vi.fn<(slug: string) => Promise<ServicesResponse>>();

vi.mock("../src/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return {
    ...actual,
    api: {
      fingerprintPolicy: (slug: string) => fingerprintPolicy(slug),
      updateFingerprintPolicy: (
        slug: string,
        patch: Partial<FingerprintPolicyDto>,
      ) => updateFingerprintPolicy(slug, patch),
      revertFingerprintPolicy: (slug: string) => revertFingerprintPolicy(slug),
      services: (slug: string) => services(slug),
    },
  };
});

const { FingerprintPolicy } = await import("../src/views/FingerprintPolicy.js");

const POLICY: FingerprintPolicyDto = {
  enabled: true,
  defaultMode: "normal",
  probes: [
    {
      id: "companion",
      label: "Companion app",
      macos: "/Applications/Companion.app",
      windows: "C:\\Program Files\\Companion",
    },
    { id: "driver", label: "Audio driver", linux: "/lib/modules/companion.ko" },
  ],
};

const SERVICES: ServicesResponse = {
  services: {
    license: { enabled: true },
    config: { enabled: false },
    release: { enabled: true },
    update: { enabled: true },
    identity: { enabled: false },
  },
  registration: null,
  effectiveRegistration: "requires-license",
  source: "manifest",
};

function renderPolicy() {
  return render(
    <Toaster>
      <FingerprintPolicy slug="djdl" />
    </Toaster>,
  );
}

/** Open a Radix select and pick an option by its visible label. */
async function pick(comboboxName: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole("combobox", { name: comboboxName }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

beforeEach(() => {
  resetCache();
  fingerprintPolicy.mockReset();
  updateFingerprintPolicy.mockReset();
  revertFingerprintPolicy.mockReset();
  services.mockReset();
  fingerprintPolicy.mockResolvedValue({ policy: POLICY, source: "manifest" });
  updateFingerprintPolicy.mockResolvedValue({
    policy: POLICY,
    source: "admin",
  });
  revertFingerprintPolicy.mockResolvedValue({
    policy: POLICY,
    source: "manifest",
  });
  services.mockResolvedValue(SERVICES);
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

describe("Enrollment & fingerprints — the policy card", () => {
  it("renders the enforcement switch, the default mode, and who owns the row", async () => {
    renderPolicy();

    const enforce = await screen.findByRole("switch", {
      name: "Enforce fingerprints",
    });
    expect(enforce.getAttribute("aria-checked")).toBe("true");
    // The mode is shown as the chosen option's label, not the wire value: "normal" alone tells an
    // operator nothing about how much drift a seat survives.
    expect(
      screen.getByRole("combobox", { name: "Default mode" }).textContent,
    ).toContain("Normal");
    // Whether a resync can overwrite this policy is the difference between a change that sticks
    // and one that silently disappears on the next push.
    expect(screen.getByText("manifest-owned")).toBeTruthy();
  });

  it("patches enabled and defaultMode together, and never the probe list", async () => {
    renderPolicy();
    await screen.findByRole("switch", { name: "Enforce fingerprints" });

    await userEvent.click(
      screen.getByRole("switch", { name: "Enforce fingerprints" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save policy" }));

    await waitFor(() =>
      expect(updateFingerprintPolicy).toHaveBeenCalledTimes(1),
    );
    const [slug, patch] = updateFingerprintPolicy.mock.calls[0]!;
    expect(slug).toBe("djdl");
    expect(patch).toEqual({ enabled: false, defaultMode: "normal" });
    // The PATCH REPLACES `probes` wholesale. Echoing the list back would claim admin ownership of
    // an array this card cannot edit, so the key must be absent — not merely equal to what it was.
    expect("probes" in patch).toBe(false);
  });

  it("sends the newly chosen mode", async () => {
    renderPolicy();
    await screen.findByRole("switch", { name: "Enforce fingerprints" });

    await pick("Default mode", "Strict");
    await userEvent.click(screen.getByRole("button", { name: "Save policy" }));

    await waitFor(() =>
      expect(updateFingerprintPolicy).toHaveBeenCalledWith("djdl", {
        enabled: true,
        defaultMode: "strict",
      }),
    );
  });

  it("keeps save inert until something actually differs from the server's copy", async () => {
    // Re-saving an unchanged policy would flip `source` to admin and quietly take the row off the
    // manifest — a write with no visible change but a permanent consequence.
    renderPolicy();
    await screen.findByRole("switch", { name: "Enforce fingerprints" });

    expect(
      screen
        .getByRole("button", { name: "Save policy" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(updateFingerprintPolicy).not.toHaveBeenCalled();
  });

  it("hands the policy back to the manifest and re-reads who owns it", async () => {
    fingerprintPolicy.mockReset();
    fingerprintPolicy
      .mockResolvedValueOnce({ policy: POLICY, source: "admin" })
      .mockResolvedValue({ policy: POLICY, source: "manifest" });
    renderPolicy();

    expect(await screen.findByText("admin-owned")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Revert to manifest/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Return to manifest" }),
    );

    await waitFor(() =>
      expect(revertFingerprintPolicy).toHaveBeenCalledWith("djdl"),
    );
    // The badge is the only place ownership is visible, so a revert that did not invalidate the
    // resource would leave the card claiming admin ownership it no longer has.
    expect(await screen.findByText("manifest-owned")).toBeTruthy();
    expect(screen.queryByText("admin-owned")).toBeNull();
  });
});

describe("Enrollment & fingerprints — probes", () => {
  it("lists every declared probe by label", async () => {
    renderPolicy();

    expect(await screen.findByText("Companion app")).toBeTruthy();
    expect(screen.getByText("Audio driver")).toBeTruthy();
    // The per-platform hints are the reason the list is read-only here; showing them is what makes
    // the "authored in the manifest" claim checkable by the operator.
    expect(screen.getByText("/Applications/Companion.app")).toBeTruthy();
    expect(screen.getByText("/lib/modules/companion.ko")).toBeTruthy();
  });

  it("says so plainly when the manifest declares none", async () => {
    fingerprintPolicy.mockResolvedValue({
      policy: { ...POLICY, probes: [] },
      source: "manifest",
    });
    renderPolicy();

    expect(await screen.findByText("No probes declared")).toBeTruthy();
  });
});

describe("Enrollment & fingerprints — device registration is read-only here", () => {
  it("shows the enforced policy from the service set without offering to edit it", async () => {
    renderPolicy();

    // Registration is derived from the ENABLED SERVICE SET, so it has exactly one editor. This
    // view shows it because a fingerprint is meaningless if a device can never register at all.
    expect(await screen.findByText("Device registration")).toBeTruthy();
    expect(screen.getByText("requires-license")).toBeTruthy();
    expect(screen.getByText("derived from services")).toBeTruthy();

    // A second control over one value is how two screens end up disagreeing. The only combobox on
    // this page is the fingerprint mode; registration gets no editor and points at its owner.
    expect(
      screen.queryByRole("combobox", { name: /registration/i }),
    ).toBeNull();
    expect(screen.queryByRole("switch", { name: /registration/i })).toBeNull();
    expect(screen.getByText(/Platform → Services/)).toBeTruthy();
  });

  it("degrades to a stated failure rather than an empty registration claim", async () => {
    // Rendering nothing (or a default) here would read as "open", which is the most permissive
    // answer this view could give for a fact it does not actually have.
    services.mockRejectedValue(new Error("services unreachable"));
    renderPolicy();

    expect(
      await screen.findByText(/Couldn.t load the registration policy/),
    ).toBeTruthy();
    expect(screen.queryByText("requires-license")).toBeNull();
  });

  it("shows an empty state with a working retry when the policy fails to load", async () => {
    fingerprintPolicy.mockReset();
    fingerprintPolicy
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ policy: POLICY, source: "manifest" });
    renderPolicy();

    expect(
      await screen.findByText("Couldn’t load the fingerprint policy"),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("switch", { name: "Enforce fingerprints" }),
    ).toBeTruthy();
  });
});
