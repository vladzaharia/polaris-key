import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AdminPersonalToken } from "../src/api.js";
import { boot, resetConsole } from "./consoleHarness.js";

/** The Superadmin's roster of people's personal tokens (`#/personal-tokens`, F-33). */

const base: AdminPersonalToken = {
  id: "pt_a",
  email: "ada@example.com",
  label: "Ada laptop",
  hint: "Hq2a",
  scope: "packages:read",
  createdAt: 1_750_000_000,
  expiresAt: 4_102_444_800,
  lastUsedAt: null,
  revokedAt: null,
  revokeReason: null,
  status: "active",
};
let roster: AdminPersonalToken[] = [];

beforeEach(() => {
  resetConsole();
  roster = [base, { ...base, id: "pt_e", label: "Gone", email: null }];
});
afterEach(() => cleanup());

describe("Personal tokens roster", () => {
  it("lists whose each token is by name and last four, never a secret, and revokes after a confirmation", async () => {
    const user = userEvent.setup();
    const log = boot("#/personal-tokens", {
      extra: {
        "/manage/api/account-tokens": () => ({ tokens: roster }),
        "DELETE /manage/api/account-tokens/pt_a": () => {
          roster = roster.map((t) =>
            t.id === "pt_a"
              ? {
                  ...t,
                  status: "revoked",
                  revokeReason: "admin",
                  revokedAt: 1_750_100_000,
                }
              : t,
          );
          return { ok: true, token: roster[0] };
        },
      },
    });
    await screen.findByRole("heading", { level: 1, name: "Personal tokens" });
    const table = await screen.findByRole("table", {
      name: "Personal tokens",
    });
    expect(within(table).getByText("ada@example.com")).toBeTruthy();
    expect(within(table).getAllByText("pkeyp_…Hq2a").length).toBe(2);
    expect(within(table).getByText("Erased")).toBeTruthy();
    await user.click(
      within(table).getByRole("button", { name: "Actions for Ada laptop" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: /Revoke/ }));
    const confirm = await screen.findByRole("alertdialog");
    expect(log.calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(
      within(confirm).getByRole("button", { name: "Revoke token" }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "DELETE")?.path).toBe(
        "/manage/api/account-tokens/pt_a",
      ),
    );
    await waitFor(() =>
      expect(within(table).getAllByText("Revoked").length).toBeGreaterThan(0),
    );
    // The row says who ended it, in place of the expiry.
    expect(within(table).getAllByText(/by admin/).length).toBeGreaterThan(0);
    // Focus does not fall to the body.
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });
});
