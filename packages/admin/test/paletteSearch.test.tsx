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
              tier: "Pro",
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
    await within(dialog).findByText("Mara Fennick");
    const licenses = await within(dialog).findByRole("group", {
      name: "Licenses",
    });
    const row = within(licenses).getByRole("option");
    expect(row.textContent).toContain("Mara Fennick");
    expect(row.textContent).toContain("mara@tidewater.io · Acme · Pro");
    expect(row.textContent).toContain("Disabled");
    const people = within(dialog).getByRole("group", { name: "Users" });
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
          key: {
            product: "acme",
            productName: "Acme",
            id: "lic_9",
            licenseId: "lic_9",
            name: "Mara Fennick",
            email: null,
            status: "disabled",
            expiresAt: null,
            tier: "Pro",
          },
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
    // Drawn like a license row: whose it is, the product, the tier and its issue.
    expect(row.textContent).toContain("Mara Fennick · Acme · Pro");
    expect(row.textContent).toContain("Disabled");
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
    await within(dialog).findByText(
      /Couldn't search licenses and people\. Try again/,
    );
    // The row is the only one, so it is selected: Enter asks again and the palette stays open.
    await userEvent.keyboard("{Enter}");
    await within(dialog).findByText(/Too many searches/);
  });

  it("sends the query in a POST body, never the URL", async () => {
    const log = boot("#/p/djdl", { services: ALL_ON });
    await screen.findByRole("navigation", { name: "Console" });
    const { dialog, input } = await openPalette();
    await userEvent.type(input, KEY);
    await within(dialog).findByRole("option", {
      name: /No license for this key/,
    });
    const call = log.calls.find((c) => c.path.includes("/search"))!;
    expect(call.path).not.toContain("pkey_");
    expect(call.path).not.toContain("?");
  });

  it("says it is searching, never 'Nothing matches', until the search has answered", async () => {
    let release: (r: Response) => void = () => {};
    boot("#/p/djdl", {
      services: ALL_ON,
      extra: {
        "/manage/api/search": () =>
          new Promise<Response>((res) => {
            release = res;
          }),
      },
    });
    await screen.findByRole("navigation", { name: "Console" });
    const { dialog, input } = await openPalette();
    await userEvent.type(input, "fennick");
    await within(dialog).findByText("Searching licenses and people…");
    expect(within(dialog).queryByText(/Nothing matches/)).toBeNull();
    release(
      new Response(JSON.stringify({ key: null, licenses: [], people: [] }), {
        status: 200,
      }),
    );
    await within(dialog).findByText(/Nothing matches/);
  });

  it("shows 5 per group and expands the rest in place; the status lines are not results", async () => {
    const licenses = Array.from({ length: 8 }, (_, i) => ({
      product: "acme",
      productName: "Acme",
      id: `lic_${i}`,
      name: `Mara ${i}`,
      email: `m${i}@x.io`,
      status: "active",
      expiresAt: null,
      tier: null,
    }));
    boot("#/p/djdl", {
      services: ALL_ON,
      extra: { "/manage/api/search": { key: null, licenses, people: [] } },
    });
    await screen.findByRole("navigation", { name: "Console" });
    const { dialog, input } = await openPalette();
    await userEvent.type(input, "mara");
    await within(dialog).findByText("Show all 8 licenses");
    const group = await within(dialog).findByRole("group", {
      name: "Licenses",
    });
    expect(within(group).getAllByRole("option")).toHaveLength(6);
    await userEvent.click(within(group).getByText("Show all 8 licenses"));
    await waitFor(() =>
      expect(
        within(
          within(dialog).getByRole("group", { name: "Licenses" }),
        ).getAllByRole("option"),
      ).toHaveLength(8),
    );
    expect(window.location.hash).toBe("#/p/djdl");
  });

  it("keeps the picked name in Recent and uses one slot", async () => {
    boot("#/p/djdl", {
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
              email: null,
              status: "active",
              expiresAt: null,
              tier: null,
            },
          ],
          people: [],
        },
      },
    });
    await screen.findByRole("navigation", { name: "Console" });
    const { input } = await openPalette();
    await userEvent.type(input, "fennick");
    await screen.findByRole("option", { name: /Mara Fennick/ });
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/acme/license/licenses/lic_1"),
    );
    const ids = JSON.parse(
      window.localStorage.getItem("pk-admin-recent-commands") ?? "[]",
    ) as string[];
    expect(ids.some((i) => i.startsWith("entity:"))).toBe(false);
    expect(window.localStorage.getItem("pk-admin-recent-names")).toContain(
      "Mara Fennick",
    );
  });
});
