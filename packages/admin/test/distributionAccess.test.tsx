/**
 * Distribution → Access (admin chunk 9, ADMIN.md §6.4 T4): delivery access per deliverable, moved
 * from Update settings. One form per deliverable (UPS-1, UPS-6), pack gates (UPS-5, DLV-3), no
 * "Public" while loading or on error (UPS-3), revert only while the console owns the app row
 * (UPS-4, UPS-7), and a refetch never wipes an edit (UPS-2).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { resetConsole } from "./consoleHarness.js";
import { qk } from "../src/console/data/queries.js";
import {
  ACCESS,
  accessSetting,
  apiError,
  bootWith,
  P,
  writes,
} from "./distributionFixture.js";

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});
const HASH = "#/p/djdl/distribution/access";
const KEY = P("/settings/distribution.access");

beforeEach(() => resetConsole());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function section(name: string): Promise<HTMLElement> {
  return screen.findByRole("region", { name });
}

describe("Distribution → Access", () => {
  it("shows the app and each pack, each with its own owner", async () => {
    bootWith(HASH);
    const app = await section("App");
    expect(
      screen.getByRole("heading", { level: 1, name: "Access" }),
    ).toBeTruthy();
    expect(
      (
        within(app).getByRole("radio", {
          name: /^Licensed/,
        }) as HTMLButtonElement
      ).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(app).getByRole("button", { name: /From manifest/ }),
    ).toBeTruthy();
    const pack = await section("textures");
    expect(
      within(pack).getByText(/inherits the app's mode \(Licensed\)/),
    ).toBeTruthy();
  });

  it("saves the app's mode to Distribution's delivery access only", async () => {
    const { calls } = bootWith(HASH);
    const app = await section("App");
    await userEvent.click(within(app).getByRole("radio", { name: /Entitled/ }));
    const bar = await screen.findByRole("region", {
      name: "Unsaved changes in App",
    });
    await userEvent.click(
      within(bar).getByRole("button", { name: "Save changes" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: KEY,
          method: "PATCH",
          body: { value: { app: { mode: "entitled" } }, expectedVersion: 0 },
        }),
      ]),
    );
    expect(
      calls.some(
        (c) =>
          c.path === P("/settings/update.metadataAccess") && c.method !== "GET",
      ),
    ).toBe(false);
  });

  it("sets a pack's gate from the catalog's flags, saving only that pack", async () => {
    const { calls } = bootWith(HASH);
    const app = await section("App");
    await userEvent.click(within(app).getByRole("radio", { name: /Public/ }));
    const pack = await section("textures");
    await userEvent.click(
      within(pack).getByRole("radio", { name: /Entitled/ }),
    );
    expect(
      await within(pack).findByText(/nobody can download this pack/),
    ).toBeTruthy();
    await userEvent.click(within(pack).getByRole("button", { name: /^Flag/ }));
    await userEvent.click(
      await screen.findByRole("option", { name: /Pro content/ }),
    );
    const bar = await screen.findByRole("region", {
      name: "Unsaved changes in textures",
    });
    await userEvent.click(
      within(bar).getByRole("button", { name: "Save changes" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: KEY,
          body: {
            value: {
              textures: { mode: "entitled", entitlement: "pro-content" },
            },
            expectedVersion: 0,
          },
        }),
      ]),
    );
  });

  it("offers Revert to manifest only on a console-owned app row", async () => {
    const owned = {
      ...ACCESS,
      app: { ...ACCESS.app, source: "admin" },
      deliverables: ACCESS.deliverables.map((d) => ({ ...d, source: "admin" })),
    };
    const { calls } = bootWith(HASH, {
      [KEY]: () => accessSetting(owned),
    });
    const app = await section("App");
    await userEvent.click(
      within(app).getByRole("button", { name: /Set in console/ }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Revert/ }),
    );
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Revert to manifest" }),
    );
    await waitFor(() =>
      expect(writes(calls).map((c) => `${c.method} ${c.path}`)).toEqual([
        `DELETE ${KEY}`,
      ]),
    );
  });

  it("keeps an edit through a background refetch (UPS-2)", async () => {
    const { queryClient } = bootWith(HASH);
    const app = await section("App");
    await userEvent.click(within(app).getByRole("radio", { name: /Public/ }));
    await queryClient.invalidateQueries({ queryKey: qk.access("djdl") });
    await new Promise((r) => setTimeout(r, 50));
    expect(
      within(app)
        .getByRole("radio", { name: /Public/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("brings a pack's section into focus from ?deliverable= (DLV-3)", async () => {
    bootWith(`${HASH}?deliverable=textures`);
    const pack = await section("textures");
    await waitFor(() => expect(document.activeElement).toBe(pack));
  });

  it("never shows a mode it could not read (UPS-3)", async () => {
    let fail = true;
    bootWith(HASH, {
      [KEY]: () => (fail ? apiError(500, "internal") : accessSetting()),
    });
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(screen.queryByRole("radio", { name: /Public/ })).toBeNull();
    fail = false;
    await userEvent.click(retry);
    expect(await section("App")).toBeTruthy();
  });

  it("shows a server refusal in the section that saved", async () => {
    bootWith(HASH, {
      [`PATCH ${KEY}`]: () =>
        apiError(500, "internal", {}, "storage unavailable"),
    });
    const app = await section("App");
    await userEvent.click(within(app).getByRole("radio", { name: /Public/ }));
    const bar = await screen.findByRole("region", {
      name: "Unsaved changes in App",
    });
    await userEvent.click(
      within(bar).getByRole("button", { name: "Save changes" }),
    );
    // A 5xx message is the server's own text: it stays in the details, not the copy (B-212).
    expect(
      await within(app).findByText("Copy the details for a support report."),
    ).toBeTruthy();
    expect(within(app).queryByText("storage unavailable")).toBeNull();
    expect(
      within(app).getByText("Something went wrong on the server"),
    ).toBeTruthy();
  });

  it("passes axe", async () => {
    bootWith(HASH);
    await section("textures");
    const results = await axe(document.body);
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      ),
    ).toEqual([]);
  });
});
