import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ALL_ON, boot, resetConsole } from "./consoleHarness.js";

/**
 * ST-52: the palette's entity search (licenses, people) and pasted-key resolution, over
 * `GET /manage/api/search`. Keyboard only throughout.
 */

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const KEY = `pkey_acme_${"A".repeat(22)}`;
const SUBJECT = `ps_${"B".repeat(22)}`;

async function openPalette(): Promise<{
  dialog: HTMLElement;
  input: HTMLElement;
}> {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const dialog = await screen.findByRole("dialog", {
    name: "Command palette",
  });
  return {
    dialog,
    input: within(dialog).getByRole("combobox", { name: "Search or jump to" }),
  };
}

describe("palette entity search (ST-52)", () => {
  it("shows licenses and people as sentences with their product, and Enter opens the first", async () => {
    const log = boot("#/p/djdl", {
      services: ALL_ON,
      extra: {
        "/manage/api/search": {
          key: null,
          licenses: [
            {
              product: "acme",
              productName: "Acme",
              id: "lic_1",
              name: "Mara Fennick",
              email: "mara@tidewater.io",
              status: "disabled",
              expiresAt: null,
            },
          ],
          people: [
            {
              product: "acme",
              productName: "Acme",
              subject: SUBJECT,
              name: null,
              email: "mara@tidewater.io",
            },
          ],
        },
      },
    });
    await screen.findByRole("navigation", { name: "Console" });
    const { dialog, input } = await openPalette();
    await userEvent.type(input, "mara");
    const licenses = await within(dialog).findByRole("group", {
      name: "Licenses",
    });
    const row = within(licenses).getByRole("option");
    expect(row.textContent).toContain("Mara Fennick");
    expect(row.textContent).toContain("mara@tidewater.io · Acme");
    expect(row.textContent).toContain("Disabled");
    const people = within(dialog).getByRole("group", { name: "People" });
    expect(within(people).getByRole("option").textContent).toContain(
      "mara@tidewater.io",
    );
    // One request for the whole word: the pause collapses the keystrokes.
    expect(log.calls.filter((c) => c.path.includes("/search")).length).toBe(1);
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/acme/license/licenses/lic_1"),
    );
  });

  it("asks nothing for one character", async () => {
    const log = boot("#/p/djdl", { services: ALL_ON });
    await screen.findByRole("navigation", { name: "Console" });
    const { input } = await openPalette();
    await userEvent.type(input, "m");
    await new Promise((r) => setTimeout(r, 400));
    expect(log.calls.some((c) => c.path.includes("/search"))).toBe(false);
  });

  it("opens the license a pasted key names, and the key is in no row, href or recent", async () => {
    boot("#/p/djdl", {
      services: ALL_ON,
      extra: {
        "/manage/api/search": {
          key: { product: "acme", licenseId: "lic_9" },
          licenses: [],
          people: [],
        },
      },
    });
    await screen.findByRole("navigation", { name: "Console" });
    const { dialog, input } = await openPalette();
    await userEvent.type(input, KEY);
    const row = await within(dialog).findByRole("option", {
      name: /Open license for this key/,
    });
    expect(row.textContent).not.toContain(KEY);
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/acme/license/licenses/lic_9"),
    );
    expect(window.location.hash).not.toContain(KEY);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(KEY);
  });

  it("says the same thing for a key it cannot resolve, unknown or not the member's", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await screen.findByRole("navigation", { name: "Console" });
    const { dialog, input } = await openPalette();
    await userEvent.type(input, KEY);
    const row = await within(dialog).findByRole("option", {
      name: /No license for this key in your products\./,
    });
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).not.toContain(KEY);
  });

  it("offers Enter to try again when the search fails, and says when it is rate-limited", async () => {
    let calls = 0;
    boot("#/p/djdl", {
      services: ALL_ON,
      extra: {
        "/manage/api/search": () =>
          ++calls === 1
            ? new Response(JSON.stringify({ error: "boom" }), { status: 500 })
            : new Response(JSON.stringify({ error: "rate_limited" }), {
                status: 429,
              }),
      },
    });
    await screen.findByRole("navigation", { name: "Console" });
    const { dialog, input } = await openPalette();
    await userEvent.type(input, "zzqq");
    await within(dialog).findByText(/Couldn't search\. Press Enter/);
    // The row is the only one, so it is selected: Enter asks again and the palette stays open.
    await userEvent.keyboard("{Enter}");
    await within(dialog).findByText(/Too many searches/);
  });
});
