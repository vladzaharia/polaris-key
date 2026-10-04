import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, type ProductDetail } from "../src/api.js";
import { resetCache } from "../src/context.js";
import { Toaster } from "../src/components/ui/index.js";
import { OutletCredentials } from "../src/views/OutletCredentials.js";

vi.mock("../src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api.js")>();
  return {
    ...actual,
    api: {
      product: vi.fn(),
      putProductSecret: vi.fn(),
      outletCredentials: vi.fn(),
      putOutletCredential: vi.fn(),
      deleteOutletCredential: vi.fn(),
    },
  };
});

import { api } from "../src/api.js";

const mockApi = api as unknown as {
  product: ReturnType<typeof vi.fn>;
  putProductSecret: ReturnType<typeof vi.fn>;
  outletCredentials: ReturnType<typeof vi.fn>;
  putOutletCredential: ReturnType<typeof vi.fn>;
  deleteOutletCredential: ReturnType<typeof vi.fn>;
};

const PRODUCT: ProductDetail = {
  slug: "djdl",
  name: "DJDL",
  signingKid: "djdl-2026",
  compatMin: "0.0.0",
  compatMax: "99.0.0",
  defaultMaxOfflineDays: 30,
  defaultDeviceLimit: 5,
  adminGroup: "admins",
  createdAt: 1_700_000_000,
  modifiedAt: 1_700_100_000,
  setup: {
    secrets: [
      {
        name: "EDGE_MINT__DJDL__APPLEMUSIC",
        configured: false,
        sources: ["Edge mint applemusic"],
      },
    ],
  },
};

function renderSecrets() {
  return render(
    <Toaster>
      <OutletCredentials slug="djdl" />
    </Toaster>,
  );
}

async function pick(comboboxName: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole("combobox", { name: comboboxName }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

beforeEach(() => {
  resetCache();
  vi.clearAllMocks();
  mockApi.product.mockResolvedValue({ product: PRODUCT });
  mockApi.outletCredentials.mockResolvedValue({
    ok: true,
    kinds: [],
    credentials: [],
  });
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

describe("Outlet credentials card (P5-01)", () => {
  const CRED = {
    id: "asc-team-key",
    kind: "asc-api-key",
    outletId: "app-store",
    meta: { keyId: "ABC123DEFG", issuerId: "issuer-1" },
    status: "active",
    createdAt: 1_700_000_000,
    createdBy: "admin-1",
    rotatedAt: null,
    expiresAt: null,
    lastUsedAt: null,
    lastOkAt: null,
    lastError: "401 from App Store Connect",
  };

  it("lists metadata and health, never a value", async () => {
    mockApi.outletCredentials.mockResolvedValue({
      ok: true,
      kinds: [],
      credentials: [CRED],
    });
    renderSecrets();
    const table = await screen.findByRole("table", {
      name: "Outlet credentials",
    });
    expect(within(table).getByText("asc-team-key")).toBeTruthy();
    expect(within(table).getByText("App Store Connect API key")).toBeTruthy();
    expect(within(table).getByText("ABC123DEFG · issuer-1")).toBeTruthy();
    expect(within(table).getByText("app-store")).toBeTruthy();
    expect(within(table).getByText("never")).toBeTruthy();
    expect(within(table).getByText("Error")).toBeTruthy();
    // No pin on this App Store Connect key: its connector is off, and the row says so.
    expect(within(table).getByText("Not pinned")).toBeTruthy();
  });

  it("shows the operator's pin apart from the key's metadata (P5-02f)", async () => {
    mockApi.outletCredentials.mockResolvedValue({
      ok: true,
      kinds: [],
      pins: {
        "asc-api-key": {
          field: "appleId",
          label: "App Store Connect app id (Apple ID)",
        },
      },
      credentials: [{ ...CRED, meta: { ...CRED.meta, appleId: "1234567890" } }],
    });
    renderSecrets();
    const table = await screen.findByRole("table", {
      name: "Outlet credentials",
    });
    expect(within(table).getByText("ABC123DEFG · issuer-1")).toBeTruthy();
    expect(within(table).getByText("1234567890")).toBeTruthy();
    expect(within(table).queryByText("Not pinned")).toBeNull();
  });

  it("re-pins a credential without its value (P5-02f)", async () => {
    mockApi.outletCredentials.mockResolvedValue({
      ok: true,
      kinds: [],
      credentials: [{ ...CRED, meta: { ...CRED.meta, appleId: "1234567890" } }],
    });
    mockApi.putOutletCredential.mockResolvedValue({
      ok: true,
      id: "asc-team-key",
    });
    renderSecrets();
    await userEvent.click(
      await screen.findByRole("button", { name: "Pin asc-team-key" }),
    );
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText(
      "App Store Connect app id (Apple ID)",
    ) as HTMLInputElement;
    expect(input.value).toBe("1234567890");
    await userEvent.clear(input);
    await userEvent.type(input, "5555555555");
    await userEvent.click(within(dialog).getByRole("button", { name: "Pin" }));
    await waitFor(() =>
      expect(mockApi.putOutletCredential).toHaveBeenCalledWith(
        "djdl",
        "asc-team-key",
        { kind: "asc-api-key", pin: "5555555555" },
      ),
    );
  });

  it("sets an App Store Connect key write-only and clears the form", async () => {
    mockApi.putOutletCredential.mockResolvedValue({
      ok: true,
      id: "asc-team-key",
    });
    renderSecrets();
    const form = await screen.findByRole("form", {
      name: "Set an outlet credential",
    });
    await userEvent.type(
      within(form).getByLabelText("Credential id"),
      "asc-team-key",
    );
    await userEvent.type(
      within(form).getByLabelText("Outlet (optional)"),
      "app-store",
    );
    await userEvent.type(within(form).getByLabelText("Key ID"), "ABC123DEFG");
    await userEvent.type(within(form).getByLabelText("Issuer ID"), "issuer-1");
    await userEvent.type(within(form).getByLabelText(".p8 private key"), "PEM");
    // The pin is required with the key (P5-02f).
    await userEvent.click(
      within(form).getByRole("button", { name: "Set credential" }),
    );
    expect(
      within(form).getByText(
        "App Store Connect app id (Apple ID) is required.",
      ),
    ).toBeTruthy();
    expect(mockApi.putOutletCredential).not.toHaveBeenCalled();
    await userEvent.type(
      within(form).getByLabelText("App Store Connect app id (Apple ID)"),
      "1234567890",
    );
    await userEvent.click(
      within(form).getByRole("button", { name: "Set credential" }),
    );
    await waitFor(() =>
      expect(mockApi.putOutletCredential).toHaveBeenCalledWith(
        "djdl",
        "asc-team-key",
        {
          kind: "asc-api-key",
          value: { keyId: "ABC123DEFG", issuerId: "issuer-1", p8: "PEM" },
          pin: "1234567890",
          outletId: "app-store",
        },
      ),
    );
    await waitFor(() =>
      expect(
        (within(form).getByLabelText(".p8 private key") as HTMLTextAreaElement)
          .value,
      ).toBe(""),
    );
  });

  it("sends a Google key as its JSON file, with its package-name pin", async () => {
    mockApi.putOutletCredential.mockResolvedValue({ ok: true, id: "play" });
    renderSecrets();
    const form = await screen.findByRole("form", {
      name: "Set an outlet credential",
    });
    await userEvent.type(within(form).getByLabelText("Credential id"), "play");
    await pick("Kind", "Google service account");
    await userEvent.type(within(form).getByLabelText("JSON key file"), "{{}");
    // The pin is required with the key (P5-03 adopts P5-02f's pin).
    await userEvent.click(
      within(form).getByRole("button", { name: "Set credential" }),
    );
    expect(
      within(form).getByText("Google Play package name is required."),
    ).toBeTruthy();
    expect(mockApi.putOutletCredential).not.toHaveBeenCalled();
    await userEvent.type(
      within(form).getByLabelText("Google Play package name"),
      "gg.acme.djdl",
    );
    await userEvent.click(
      within(form).getByRole("button", { name: "Set credential" }),
    );
    await waitFor(() =>
      expect(mockApi.putOutletCredential).toHaveBeenCalledWith("djdl", "play", {
        kind: "google-service-account",
        value: "{}",
        pin: "gg.acme.djdl",
        outletId: null,
      }),
    );
  });

  it("requires an id and every field of the kind", async () => {
    renderSecrets();
    const form = await screen.findByRole("form", {
      name: "Set an outlet credential",
    });
    await userEvent.click(
      within(form).getByRole("button", { name: "Set credential" }),
    );
    expect(within(form).getByText("A credential id is required.")).toBeTruthy();
    await userEvent.type(within(form).getByLabelText("Credential id"), "x");
    await userEvent.click(
      within(form).getByRole("button", { name: "Set credential" }),
    );
    expect(within(form).getByText("Key ID is required.")).toBeTruthy();
    expect(mockApi.putOutletCredential).not.toHaveBeenCalled();
  });

  it("deletes a credential after confirmation", async () => {
    mockApi.outletCredentials.mockResolvedValue({
      ok: true,
      kinds: [],
      credentials: [CRED],
    });
    mockApi.deleteOutletCredential.mockResolvedValue({
      ok: true,
      id: "asc-team-key",
    });
    renderSecrets();
    await userEvent.click(
      await screen.findByRole("button", { name: "Delete asc-team-key" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete" }),
    );
    await waitFor(() =>
      expect(mockApi.deleteOutletCredential).toHaveBeenCalledWith(
        "djdl",
        "asc-team-key",
      ),
    );
  });
});
