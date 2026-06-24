import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProductCatalog } from "../src/api.js";
import { resetCache } from "../src/context.js";

// Mock the typed client so the view's `useResource(schema)` + publish path are scripted.
const schema = vi.fn<(slug: string) => Promise<ProductCatalog>>();
const publishSchema = vi.fn<(slug: string, c: ProductCatalog) => Promise<{ ok: true; schemaVersion: number }>>();
vi.mock("../src/api.js", () => ({
  api: {
    schema: (slug: string) => schema(slug),
    publishSchema: (slug: string, c: ProductCatalog) => publishSchema(slug, c),
  },
}));

// Import AFTER vi.mock so the view binds to the mocked client.
const { Catalog } = await import("../src/views/Catalog.js");

const CATALOG: ProductCatalog = {
  schemaVersion: 3,
  entries: [
    {
      key: "ui.theme",
      kind: "config",
      category: "appearance",
      label: "Theme",
      description: "The default UI theme.",
      schema: { type: "string", enum: ["light", "dark"] },
      default: "dark",
      ui: { order: 1 },
    },
    {
      key: "api.token",
      kind: "secret",
      category: "secrets",
      label: "API token",
      description: "Upstream API token.",
      schema: { type: "string" },
      secret: true,
    },
    {
      key: "feature.vpn",
      kind: "flag",
      category: "entitlements",
      label: "VPN",
      description: "",
      schema: { type: "boolean" },
      managementDefault: "enforced",
    },
  ],
};

beforeEach(() => {
  resetCache();
  schema.mockReset();
  publishSchema.mockReset();
  schema.mockResolvedValue(CATALOG);
  (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () => false;
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined;
});
afterEach(cleanup);

describe("Catalog view", () => {
  it("renders entries grouped by category with kind/state badges + schema summary", async () => {
    render(<Catalog slug="djdl" />);

    // Header shows the active schema version.
    expect(await screen.findByText("schema v3")).toBeTruthy();

    // Category headings.
    expect(screen.getByText("appearance")).toBeTruthy();
    expect(screen.getByText("secrets")).toBeTruthy();
    expect(screen.getByText("entitlements")).toBeTruthy();

    // Entry labels + keys.
    expect(screen.getByText("Theme")).toBeTruthy();
    expect(screen.getByText("ui.theme")).toBeTruthy();

    // Kind badges (one per entry).
    expect(screen.getByText("config")).toBeTruthy();
    expect(screen.getByText("secret")).toBeTruthy();
    expect(screen.getByText("flag")).toBeTruthy();

    // Management-state badge for the flag entry.
    expect(screen.getByText("enforced")).toBeTruthy();

    // Schema summary surfaces the enum.
    expect(screen.getByText(/enum: light \| dark/)).toBeTruthy();

    // Secret default is withheld, not the raw value.
    expect(screen.getByText("— (write-only)")).toBeTruthy();
  });

  it("shows an error state with a retry that re-fetches", async () => {
    schema.mockReset();
    schema.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(CATALOG);
    render(<Catalog slug="djdl" />);

    expect(await screen.findByText("Couldn’t load the catalog")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Theme")).toBeTruthy();
  });

  it("publishes a new version via the dialog, calling publishSchema with the parsed catalog", async () => {
    publishSchema.mockResolvedValue({ ok: true, schemaVersion: 4 });
    render(<Catalog slug="djdl" />);
    await screen.findByText("Theme");

    await userEvent.click(screen.getByRole("button", { name: /Publish new version/ }));

    // The editor is seeded with the catalog at a bumped version.
    const editor = (await screen.findByLabelText("Catalog JSON")) as HTMLTextAreaElement;
    expect(editor.value).toContain('"schemaVersion": 4');

    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(publishSchema).toHaveBeenCalledTimes(1));
    const [calledSlug, calledCatalog] = publishSchema.mock.calls[0]!;
    expect(calledSlug).toBe("djdl");
    expect(calledCatalog.schemaVersion).toBe(4);
    expect(calledCatalog.entries).toHaveLength(3);
  });

  it("disables Publish and shows an error when the draft JSON is invalid", async () => {
    render(<Catalog slug="djdl" />);
    await screen.findByText("Theme");
    await userEvent.click(screen.getByRole("button", { name: /Publish new version/ }));

    const editor = await screen.findByLabelText("Catalog JSON");
    await userEvent.clear(editor);
    await userEvent.type(editor, "{{ not json");

    const dialog = screen.getByRole("dialog");
    const publishBtn = within(dialog).getByRole("button", { name: "Publish" }) as HTMLButtonElement;
    expect(publishBtn.disabled).toBe(true);
    expect(within(dialog).getByRole("alert").textContent).toMatch(/Invalid JSON/);
    expect(publishSchema).not.toHaveBeenCalled();
  });
});
