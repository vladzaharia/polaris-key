import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConfigEntry, ProductCatalog } from "../src/api.js";
import { resetConsole } from "./consoleHarness.js";
import { bootConfig } from "./configHarness.js";

/**
 * The publish review's Cloud Sync encryption notice (U-32, plan-cloud-sync §2.8): shown only when
 * the encryption the draft started from differs from the active catalog's, and only for a product
 * with synced data. Neither direction rewrites anything.
 */

const P = "/manage/api/products/djdl";
const entry = (label: string): ConfigEntry => ({
  key: "network.timeout",
  kind: "config",
  category: "Network",
  label,
  description: "",
  schema: { type: "integer", minimum: 1 },
  default: 30,
});
const catalog = (encryption?: "e2e" | "server"): ProductCatalog => ({
  schemaVersion: 8,
  entries: [entry("Timeout")],
  ...(encryption ? { cloudSync: { encryption } as never } : {}),
});
const usage = (people: number) => ({
  enabled: true,
  usage: { people, bytes: 0, breakdown: { byTier: [], byKind: {} } },
  tiers: [],
  defaultBytes: 1,
  paused: null,
});

function seedDraft(baseEncryption: "e2e" | "server" | undefined): void {
  window.sessionStorage.setItem(
    "pk-catalog-draft:djdl",
    JSON.stringify({
      baseVersion: 8,
      baseEntries: [entry("Timeout")],
      ...(baseEncryption ? { baseEncryption } : {}),
      entries: [entry("Request timeout")],
    }),
  );
}

async function review(
  active: ProductCatalog,
  people: number,
): Promise<HTMLElement> {
  bootConfig("#/p/djdl/config/catalog/edit?entry=network.timeout", {
    [`${P}/config/catalog`]: active,
    [`${P}/config/catalog/usage`]: { keys: {} },
    [`${P}/sync/usage`]: usage(people),
  });
  await screen.findByRole("heading", { level: 1, name: "Edit catalog" });
  await userEvent.click(
    await screen.findByRole("button", { name: /^Review (\d+ )?changes?$/ }),
  );
  return screen.findByRole("dialog", { name: "Publish version 9" });
}

beforeEach(() => {
  resetConsole();
  window.sessionStorage.clear();
});
afterEach(() => cleanup());

describe("Publish review: encryption notice", () => {
  it("says End-to-end to Readable by Polaris Key, and that nothing is rewritten", async () => {
    seedDraft("e2e");
    const drawer = await review(catalog("server"), 12);
    const note = await within(drawer).findByText(/Encryption changes/);
    const text = note.closest("[role]")?.textContent ?? note.textContent ?? "";
    expect(text).toContain(
      "End-to-end to Readable by Polaris Key. Data already synced stays as it is. New saves are readable by Polaris Key.",
    );
  });

  it("says the other way too", async () => {
    seedDraft("server");
    const drawer = await review(catalog(), 12);
    const note = await within(drawer).findByText(/Encryption changes/);
    const text = note.closest("[role]")?.textContent ?? note.textContent ?? "";
    expect(text).toContain("Readable by Polaris Key to End-to-end.");
    expect(text).toContain("out of Polaris Key's reach");
  });

  it("is absent when the encryption is the same", async () => {
    seedDraft("e2e");
    const drawer = await review(catalog("e2e"), 12);
    await within(drawer).findByRole("button", { name: "Publish version 9" });
    expect(within(drawer).queryByText(/Encryption changes/)).toBeNull();
  });

  it("is absent for a draft saved before the field existed", async () => {
    seedDraft(undefined);
    const drawer = await review(catalog("server"), 12);
    await within(drawer).findByRole("button", { name: "Publish version 9" });
    expect(within(drawer).queryByText(/Encryption changes/)).toBeNull();
  });

  it("is absent while nobody has synced", async () => {
    seedDraft("e2e");
    const drawer = await review(catalog("server"), 0);
    await waitFor(() =>
      expect(
        within(drawer).getByRole("button", { name: "Publish version 9" }),
      ).toBeTruthy(),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(within(drawer).queryByText(/Encryption changes/)).toBeNull();
  });
});
