/**
 * License → Licenses → New license (LX-29; S-24 §8; FLOWS.md C-17) through the whole console: the
 * five-step drawer on the wizard kit, its three outcomes (assigned and emailed, one floating key, a
 * batch with a CSV), the one-time results, the discard guard and the resumable draft.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resetConsole } from "./consoleHarness.js";
import {
  API,
  ADA,
  DEFAULT_TIER,
  EDU,
  LICENSES,
  PRO,
  axe,
  bootLicense,
  failing,
  writes,
} from "./licenseFixture.js";
import { endOfLocalDay } from "../src/lib/format.js";
import {
  deliveriesFor,
  deliveryOf,
  EMPTY,
  loadDraft,
} from "../src/console/sections/license/wizard/draft.js";

beforeEach(() => {
  resetConsole();
  window.sessionStorage.clear();
});
afterEach(cleanup);

const table = () => screen.findByRole("table", { name: "Licenses" });

async function open(routes: Record<string, unknown> = {}) {
  const log = bootLicense("#/p/djdl/license/licenses", { routes });
  await table();
  await userEvent.click(
    screen.getAllByRole("button", { name: "New license" })[0]!,
  );
  const dialog = await screen.findByRole("dialog", { name: "New license" });
  await within(dialog).findByRole("radio", { name: /Pro/ });
  return { log, dialog };
}

const primary = (dialog: HTMLElement, name: string | RegExp) =>
  within(dialog).getByRole("button", { name });
const press = (dialog: HTMLElement, name: string | RegExp) =>
  userEvent.click(primary(dialog, name));
const heading = (dialog: HTMLElement) =>
  within(dialog).getAllByRole("heading", { level: 2 })[1]!;

async function choose(dialog: HTMLElement, name: RegExp) {
  await userEvent.click(within(dialog).getByRole("radio", { name }));
}

/** Tier → holder → limits → delivery → review, with the defaults, for a person. */
async function toReview(dialog: HTMLElement, email = "grace@x.io") {
  await choose(dialog, /^Pro/);
  await press(dialog, "Continue");
  await userEvent.type(within(dialog).getByLabelText(/^Email/), email);
  await press(dialog, "Continue");
  await press(dialog, "Continue");
  await press(dialog, "Continue");
  await within(dialog).findByText("Polaris Key will");
}

const GOT = (log: ReturnType<typeof bootLicense>, suffix: string) =>
  writes(log).filter((w) => w.path.endsWith(suffix));

describe("New license wizard", () => {
  it("opens in the URL on the first step, and Escape asks before dropping a draft (C-17)", async () => {
    const { dialog } = await open();
    expect(window.location.hash).toContain("setup=new-license&step=tier");
    expect(heading(dialog).textContent).toContain("Step 1 of 5");
    await choose(dialog, /^Pro/);
    await press(dialog, "Continue");
    await waitFor(() =>
      expect(heading(dialog).textContent).toContain("Who it's for"),
    );
    await waitFor(() => expect(document.activeElement).toBe(heading(dialog)));
    await userEvent.type(within(dialog).getByLabelText(/^Email/), "g@x.io");
    fireEvent.keyDown(dialog, { key: "Escape" });
    const strip = await within(dialog).findByRole("alert");
    expect(strip.textContent).toContain("Discard this license?");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Keep editing" }),
    );
    expect(within(dialog).getByLabelText(/^Email/)).toHaveProperty(
      "value",
      "g@x.io",
    );
    fireEvent.keyDown(dialog, { key: "Escape" });
    await userEvent.click(
      await within(dialog).findByRole("button", { name: "Discard" }),
    );
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/djdl/license/licenses"),
    );
    expect(window.sessionStorage.getItem("pk-new-license:djdl")).toBeNull();
  });

  it("shows every holder error on Continue, none naming an account (D4)", async () => {
    const { log, dialog } = await open();
    await press(dialog, "Continue");
    await press(dialog, "Continue");
    expect(await within(dialog).findByText("Enter their email.")).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText(/^Email/), "bad");
    await press(dialog, "Continue");
    expect(
      await within(dialog).findByText("Enter a valid email address."),
    ).toBeTruthy();
    expect(writes(log)).toEqual([]);
    // The line under the email is the same whatever the address is.
    expect(
      within(dialog).getByText(
        "If this email has a verified account, the license joins it.",
      ),
    ).toBeTruthy();
  });

  it("creates an assigned license with a device limit and emails the key, shown once", async () => {
    const { log, dialog } = await open({
      [`POST ${API}/license/licenses`]: {
        licenseId: "lic_new",
        key: "PK-NEWKEY-ONESHOT",
        delivered: { email: "sent" },
        license: ADA,
      },
    });
    await choose(dialog, /^Pro/);
    await press(dialog, "Continue");
    await userEvent.type(within(dialog).getByLabelText(/^Email/), "g@x.io");
    await userEvent.type(within(dialog).getByLabelText(/^Name/), "Grace");
    await press(dialog, "Continue");
    // Limits: the tier's own are filled in; override only the devices.
    expect(within(dialog).getByText(/Use Pro's limit \(5\)/)).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("radio", { name: "Set for this license" }),
    );
    await userEvent.type(within(dialog).getByLabelText("Device limit"), "3");
    expect(
      within(
        within(dialog).getByRole("region", { name: "What devices receive" }),
      ).getByText("3"),
    ).toBeTruthy();
    await press(dialog, "Continue");
    // Delivery: email and show once is the default; the preview never shows a real key.
    expect(
      within(dialog).getByRole("radio", { name: /Email the key and show it/ }),
    ).toHaveProperty("ariaChecked", "true");
    expect(within(dialog).getByLabelText("Email preview")).toBeTruthy();
    await press(dialog, "Continue");
    expect(within(dialog).getByText("Grace")).toBeTruthy();
    await press(dialog, "Create and email license");
    expect(await within(dialog).findByText("PK-NEWKEY-ONESHOT")).toBeTruthy();
    expect(GOT(log, "/license/licenses")[0]!.body).toEqual({
      email: "g@x.io",
      name: "Grace",
      tier: "pro",
      deviceLimit: 3,
      delivery: { email: true },
    });
    expect(within(dialog).getByText("Emailed to g@x.io.")).toBeTruthy();
    await waitFor(() =>
      expect(heading(dialog).textContent).toContain("License created"),
    );
    expect(
      within(dialog).getByText("Shown once. It is in their email too."),
    ).toBeTruthy();
    expect(within(dialog).getAllByText(/shown once/i)).toHaveLength(1);
    // The email went out: the key is a courtesy, nothing waits and nothing asks.
    expect(within(dialog).queryByLabelText(/I've stored it/)).toBeNull();
    expect(
      primary(dialog, "Open license").getAttribute("aria-disabled"),
    ).toBeNull();
    await userEvent.click(primary(dialog, "Open license"));
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/djdl/license/licenses/lic_new"),
    );
  });

  it("says 'Key not emailed' with the reason, and Try again waits for the key to be stored", async () => {
    const { log, dialog } = await open({
      [`POST ${API}/license/licenses`]: {
        licenseId: "lic_new",
        key: "PK-NEWKEY-ONESHOT",
        delivered: { email: "failed", reason: "provider_refused" },
        license: ADA,
      },
      [`POST ${API}/license/licenses/lic_new/send-key`]: {
        key: "PK-SECOND",
        delivered: { email: "sent" },
        revoked: 0,
      },
    });
    await toReview(dialog);
    await press(dialog, "Create and email license");
    await waitFor(() =>
      expect(heading(dialog).textContent).toContain("Key not emailed"),
    );
    expect(within(dialog).getByText("PK-NEWKEY-ONESHOT")).toBeTruthy();
    expect(
      within(dialog).getByText(/The email provider didn't accept it/),
    ).toBeTruthy();
    expect(primary(dialog, "Try again").getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(
      within(dialog).getAllByText("Tick “I've stored it” first.")[0],
    ).toBeTruthy();
    expect(primary(dialog, "Done").getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(within(dialog).getByLabelText(/I've stored it/));
    await userEvent.click(primary(dialog, "Try again"));
    await waitFor(() => expect(GOT(log, "/send-key")).toHaveLength(1));
    await waitFor(() =>
      expect(within(dialog).getByText("Emailed to grace@x.io.")).toBeTruthy(),
    );
  });

  it("creates one floating key without an email, skipping Delivery, and shows it once", async () => {
    const { log, dialog } = await open();
    await choose(dialog, /^Pro/);
    await press(dialog, "Continue");
    await choose(dialog, /Anyone with the key/);
    expect(
      within(dialog).getByText(/Floating keys aren't emailed/),
    ).toBeTruthy();
    await press(dialog, "Continue");
    await press(dialog, "Continue");
    // Delivery had one answer, so Review is next, and says how the key comes.
    await within(dialog).findByText("Polaris Key will");
    expect(within(dialog).getByText("Show it once")).toBeTruthy();
    expect(
      within(dialog).queryByRole("button", { name: "Change delivery" }),
    ).toBeNull();
    await press(dialog, "Create license");
    await within(dialog).findByText("PK-NEWKEY-ONESHOT");
    expect(GOT(log, "/license/licenses")[0]!.body).toEqual({ tier: "pro" });
    // Show it once: this screen holds the only copy, so leaving waits.
    expect(primary(dialog, "Done").getAttribute("aria-disabled")).toBe("true");
  });

  it("creates a labelled batch, offers the CSV, and will not close until it is kept", async () => {
    const { log, dialog } = await open({
      [`POST ${API}/license/batches`]: {
        batchId: "bat_1",
        licenses: [
          { licenseId: "lic_a", key: "pkey_djdl_AAA" },
          { licenseId: "lic_b", key: "pkey_djdl_BBB" },
        ],
        batch: {
          id: "bat_1",
          label: "Steam, Oct",
          count: 2,
          tier: "pro",
          createdBy: "ada",
          createdAt: 0,
          used: 0,
          unused: 2,
          disabled: 0,
        },
        expiresAt: null,
      },
    });
    await choose(dialog, /^Pro/);
    await press(dialog, "Continue");
    await choose(dialog, /Anyone with the key/);
    const count = within(dialog).getByLabelText(/How many keys/);
    await userEvent.clear(count);
    await userEvent.type(count, "2");
    await userEvent.type(
      within(dialog).getByLabelText(/Batch label/),
      "Steam, Oct",
    );
    await press(dialog, "Continue");
    await press(dialog, "Continue");
    expect(within(dialog).getByText("Download a CSV")).toBeTruthy();
    await press(dialog, "Create 2 keys");
    await waitFor(() =>
      expect(heading(dialog).textContent).toContain("2 keys created"),
    );
    expect(GOT(log, "/license/batches")[0]!.body).toEqual({
      label: "Steam, Oct",
      count: 2,
      tier: "pro",
    });
    // One primary until something is kept; Escape asks, in place, before the keys are lost.
    expect(within(dialog).getByText("These keys are shown once")).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "The 2 keys can't be shown again",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Keep it open" }),
    );
    expect(primary(dialog, "Done").getAttribute("aria-disabled")).toBe("true");
    expect(
      within(dialog).getByRole("button", { name: "Download CSV" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Copy all keys" }),
    ).toBeTruthy();
    await userEvent.click(within(dialog).getByLabelText(/I've stored them/));
    await userEvent.click(primary(dialog, "Open batch"));
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/djdl/license/batches/bat_1"),
    );
  });

  it("sends an expiry date at the end of the local day, and refuses a bad limit", async () => {
    const { log, dialog } = await open();
    await choose(dialog, /^Pro/);
    await press(dialog, "Continue");
    await userEvent.type(within(dialog).getByLabelText(/^Email/), "g@x.io");
    await press(dialog, "Continue");
    await userEvent.click(
      within(dialog).getByRole("radio", { name: "Set for this license" }),
    );
    await userEvent.type(within(dialog).getByLabelText("Device limit"), "0");
    await press(dialog, "Continue");
    expect(
      await within(dialog).findByText("Use a whole number from 1 to 1000."),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("radio", { name: "Use Pro's limit (5)" }),
    );
    await userEvent.click(
      within(dialog).getByRole("radio", { name: "On a date" }),
    );
    fireEvent.change(within(dialog).getByLabelText(/^Expiry date/), {
      target: { value: "2027-12-31" },
    });
    await press(dialog, "Continue");
    await press(dialog, "Continue");
    await press(dialog, "Create and email license");
    await within(dialog).findByText("PK-NEWKEY-ONESHOT");
    expect(GOT(log, "/license/licenses")[0]!.body).toMatchObject({
      expiresAt: Math.floor(endOfLocalDay("2027-12-31")! / 1000),
    });
  });

  it("keeps the input and says so when the create fails", async () => {
    const { dialog } = await open({
      [`POST ${API}/license/licenses`]: failing(500),
    });
    await toReview(dialog);
    await press(dialog, "Create and email license");
    expect(
      await within(dialog).findByText("Nothing was created. Try again."),
    ).toBeTruthy();
    expect(heading(dialog).textContent).toContain("Review");
    expect(within(dialog).getByText("grace@x.io")).toBeTruthy();
  });

  it("resumes a draft after the drawer is closed and opened again", async () => {
    const { dialog } = await open();
    await choose(dialog, /^Edu/);
    await press(dialog, "Continue");
    await userEvent.type(within(dialog).getByLabelText(/^Email/), "back@x.io");
    window.location.hash = "#/p/djdl/license/licenses";
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "New license" })).toBeNull(),
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: "New license" })[0]!,
    );
    const again = await screen.findByRole("dialog", { name: "New license" });
    expect(
      await within(again).findByRole("radio", { name: /^Edu/ }),
    ).toHaveProperty("ariaChecked", "true");
    await press(again, "Continue");
    expect(within(again).getByLabelText(/^Email/)).toHaveProperty(
      "value",
      "back@x.io",
    );
  });

  it("says a failed tier lookup inline, and points a product with none to Tiers", async () => {
    bootLicense("#/p/djdl/license/licenses", {
      routes: { [`${API}/license/tiers`]: failing(500) },
    });
    await table();
    await userEvent.click(
      screen.getAllByRole("button", { name: "New license" })[0]!,
    );
    const dialog = await screen.findByRole("dialog", { name: "New license" });
    expect(await within(dialog).findByText("Couldn't load tiers")).toBeTruthy();
  });

  it("preselects the first tier, so a batch never dead-ends on a missing one (F1)", async () => {
    const { dialog } = await open();
    expect(within(dialog).getByRole("radio", { name: /^Pro/ })).toHaveProperty(
      "ariaChecked",
      "true",
    );
    // There is no "No tier" card (LX-33.7).
    expect(
      within(dialog).queryByRole("radio", { name: /^No tier/ }),
    ).toBeNull();
    await choose(dialog, /^Edu/);
    await press(dialog, "Continue");
    await press(dialog, "Back");
    expect(within(dialog).getByRole("radio", { name: /^Edu/ })).toHaveProperty(
      "ariaChecked",
      "true",
    );
  });

  it("preselects the Default tier, and bulk keys default to it (LX-33.7)", async () => {
    const { dialog } = await open({
      [`${API}/license/tiers`]: { tiers: [PRO, DEFAULT_TIER, EDU] },
    });
    expect(
      within(dialog).getByRole("radio", { name: /^Default/ }),
    ).toHaveProperty("ariaChecked", "true");
    expect(
      within(dialog).getByRole("radio", { name: /^Default/ }).textContent,
    ).toContain("Used when a license names no tier");
  });

  it("Change returns to Review with one press, and the header control is Close (F9, F10)", async () => {
    const { dialog } = await open();
    await toReview(dialog);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Change who it's for" }),
    );
    await userEvent.clear(within(dialog).getByLabelText(/^Email/));
    await userEvent.type(within(dialog).getByLabelText(/^Email/), "new@x.io");
    await press(dialog, "Back to review");
    await within(dialog).findByText("Polaris Key will");
    expect(within(dialog).getAllByText(/new@x\.io/).length).toBeGreaterThan(0);
    expect(
      within(dialog).queryByRole("button", { name: "Back" }),
    ).not.toBeNull();
    expect(
      within(dialog).getAllByRole("button", { name: "Close" }),
    ).toHaveLength(1);
  });

  it("a refused value goes back to its own step, in words (F13)", async () => {
    const { dialog } = await open({
      [`POST ${API}/license/licenses`]: new Response(
        JSON.stringify({ error: "bad_request", fields: ["maxVersion"] }),
        { status: 422, headers: { "content-type": "application/json" } },
      ),
    });
    await toReview(dialog);
    await press(dialog, "Create and email license");
    await waitFor(() =>
      expect(heading(dialog).textContent).toContain("Limits"),
    );
    expect(
      within(dialog).getAllByText(
        "This value isn't accepted. Check it and try again.",
      ),
    ).toBeTruthy();
  });

  it("a deep link to Review with an empty draft lands on its first invalid step (F14)", async () => {
    bootLicense("#/p/djdl/license/licenses?setup=new-license&step=review");
    const dialog = await screen.findByRole("dialog", { name: "New license" });
    await waitFor(() => expect(window.location.hash).toContain("step=holder"));
    expect(within(dialog).getByLabelText(/^Email/)).toBeTruthy();
  });

  it("focus goes to the page title when the opener is gone (F7)", async () => {
    bootLicense("#/p/djdl/license/licenses?setup=new-license&step=tier");
    const dialog = await screen.findByRole("dialog", { name: "New license" });
    await within(dialog).findByRole("radio", { name: /Pro/ });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "New license" })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H1"));
  });

  it("a tier lookup that fails is retried, not skipped (N1)", async () => {
    bootLicense("#/p/djdl/license/licenses", {
      routes: { [`${API}/license/tiers`]: failing(500) },
    });
    await table();
    await userEvent.click(
      screen.getAllByRole("button", { name: "New license" })[0]!,
    );
    const dialog = await screen.findByRole("dialog", { name: "New license" });
    await within(dialog).findByText("Couldn't load tiers");
    expect(
      within(dialog).queryByRole("radio", { name: /^No tier/ }),
    ).toBeNull();
    expect(primary(dialog, "Continue")).toHaveProperty("disabled", true);
  });

  it("a product with no tiers yet goes on to the Worker's Default tier (N1)", async () => {
    bootLicense("#/p/djdl/license/licenses", {
      routes: { [`${API}/license/tiers`]: { tiers: [] } },
    });
    await table();
    await userEvent.click(
      screen.getAllByRole("button", { name: "New license" })[0]!,
    );
    const dialog = await screen.findByRole("dialog", { name: "New license" });
    await within(dialog).findByText("No tiers yet");
    await waitFor(() =>
      expect(primary(dialog, "Continue")).toHaveProperty("disabled", false),
    );
    await press(dialog, "Continue");
    await waitFor(() =>
      expect(heading(dialog).textContent).toContain("Who it's for"),
    );
  });

  it("a 403 says nothing was created, without 'Try again' (N6)", async () => {
    const { dialog } = await open({
      [`POST ${API}/license/licenses`]: failing(403, "forbidden"),
    });
    await toReview(dialog);
    await press(dialog, "Create and email license");
    expect(
      await within(dialog).findByText("Nothing was created."),
    ).toBeTruthy();
    // Focus stays on Create, not on the dialog container.
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain("Create and email"),
    );
  });

  it("passes axe on its steps", async () => {
    const { dialog } = await open();
    expect((await axe(document.body)).violations.map((v) => v.id)).toEqual([]);
    await choose(dialog, /^Pro/);
    await press(dialog, "Continue");
    expect((await axe(document.body)).violations.map((v) => v.id)).toEqual([]);
    await userEvent.type(within(dialog).getByLabelText(/^Email/), "g@x.io");
    await press(dialog, "Continue");
    await press(dialog, "Continue");
    await press(dialog, "Continue");
    await within(dialog).findByText("Polaris Key will");
    expect((await axe(document.body)).violations.map((v) => v.id)).toEqual([]);
  });
});

/** A product with Identity on and auto-link on: the list's first page says invitations work. */
const INVITING = {
  [`${API}/license/licenses`]: {
    licenses: LICENSES,
    holders: { invitations: true, invitationsOff: null },
  },
};

const refusal = (reason: string) =>
  new Response(
    JSON.stringify({ error: "bad_request", fields: ["delivery"], reason }),
    { status: 422, headers: { "content-type": "application/json" } },
  );

describe("New license wizard: the invitation (LX-27c.4)", () => {
  it("offers an invitation first only where Identity and auto-link are on", () => {
    const person = { ...EMPTY, who: "person" as const };
    expect(deliveriesFor({ ...person, invites: false })).toEqual([
      "email-show",
      "email",
      "show",
    ]);
    expect(deliveriesFor({ ...person, invites: true })).toEqual([
      "invite",
      "email-show",
      "show",
    ]);
    expect(deliveriesFor({ ...EMPTY, who: "anyone", invites: true })).toEqual([
      "show",
    ]);
  });

  it("defaults to an invitation and sends key: false unless the box is ticked", async () => {
    const { log, dialog } = await open({
      ...INVITING,
      [`POST ${API}/license/licenses`]: {
        licenseId: "lic_new",
        delivered: { invite: "sent" },
        license: ADA,
      },
    });
    await choose(dialog, /^Pro/);
    await press(dialog, "Continue");
    await userEvent.type(within(dialog).getByLabelText(/^Email/), "g@x.io");
    await press(dialog, "Continue");
    await press(dialog, "Continue");
    expect(
      within(dialog).getByRole("radio", { name: /Email an invitation/ }),
    ).toHaveProperty("ariaChecked", "true");
    expect(
      (
        within(dialog).getByRole("checkbox", {
          name: /Also create a key/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    const preview = within(dialog).getByLabelText("Email preview");
    expect(
      within(preview).getAllByText(/Your .* license is ready/).length,
    ).toBeGreaterThan(0);
    expect(within(preview).queryByText(/pkey_/)).toBeNull();
    await press(dialog, "Continue");
    expect(within(dialog).getByText("Email an invitation")).toBeTruthy();
    await press(dialog, "Create and invite");
    await waitFor(() =>
      expect(heading(dialog).textContent).toContain("Invitation sent"),
    );
    expect(GOT(log, "/license/licenses")[0]!.body).toEqual({
      email: "g@x.io",
      tier: "pro",
      delivery: { invite: true },
      key: false,
    });
    expect(
      within(dialog).getByText(
        /When they sign in with g@x\.io, the license is in their Polaris Locker library\./,
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/^Invitation sent to/)).toBeNull();
    // No key, so nothing to keep: Done is open.
    expect(within(dialog).queryByText("License key")).toBeNull();
    expect(primary(dialog, "Done").getAttribute("aria-disabled")).toBeNull();
  });

  it("Also create a key shows it once, gates Done, and never emails it", async () => {
    const { log, dialog } = await open({
      ...INVITING,
      [`POST ${API}/license/licenses`]: {
        licenseId: "lic_new",
        key: "PK-NEWKEY-ONESHOT",
        delivered: { invite: "sent" },
        license: ADA,
      },
    });
    await choose(dialog, /^Pro/);
    await press(dialog, "Continue");
    await userEvent.type(within(dialog).getByLabelText(/^Email/), "g@x.io");
    await press(dialog, "Continue");
    await press(dialog, "Continue");
    await userEvent.click(
      within(dialog).getByRole("checkbox", { name: /Also create a key/ }),
    );
    await press(dialog, "Continue");
    await press(dialog, "Create and invite");
    expect(await within(dialog).findByText("PK-NEWKEY-ONESHOT")).toBeTruthy();
    expect(GOT(log, "/license/licenses")[0]!.body).toEqual({
      email: "g@x.io",
      tier: "pro",
      delivery: { invite: true },
    });
    expect(within(dialog).getByText(/It isn't in the invitation/)).toBeTruthy();
    expect(primary(dialog, "Done").getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(within(dialog).getByLabelText(/I've stored it/));
    expect(primary(dialog, "Done").getAttribute("aria-disabled")).toBeNull();
  });

  it("says why a send failed and tries again through send-invite", async () => {
    const { log, dialog } = await open({
      ...INVITING,
      [`POST ${API}/license/licenses`]: {
        licenseId: "lic_new",
        delivered: { invite: "failed", reason: "provider_refused" },
        license: ADA,
      },
      [`POST ${API}/license/licenses/lic_new/send-invite`]: {
        delivered: { invite: "sent" },
      },
    });
    await choose(dialog, /^Pro/);
    await press(dialog, "Continue");
    await userEvent.type(within(dialog).getByLabelText(/^Email/), "g@x.io");
    await press(dialog, "Continue");
    await press(dialog, "Continue");
    await press(dialog, "Continue");
    await press(dialog, "Create and invite");
    await waitFor(() =>
      expect(heading(dialog).textContent).toContain("Invitation not sent"),
    );
    expect(
      within(dialog).getByText(/The email provider didn't accept it/),
    ).toBeTruthy();
    // No key exists, so Try again needs no "I've stored it".
    await userEvent.click(primary(dialog, "Try again"));
    await waitFor(() => expect(GOT(log, "/send-invite")).toHaveLength(1));
    await waitFor(() =>
      expect(
        within(dialog).getByText(/When they sign in with g@x\.io/),
      ).toBeTruthy(),
    );
    expect(GOT(log, "/send-key")).toHaveLength(0);
  });

  it("keeps the draft without the server fact or any key", async () => {
    const { dialog } = await open(INVITING);
    await choose(dialog, /^Pro/);
    await press(dialog, "Continue");
    await userEvent.type(within(dialog).getByLabelText(/^Email/), "g@x.io");
    await press(dialog, "Continue");
    await press(dialog, "Continue");
    await userEvent.click(
      within(dialog).getByRole("checkbox", { name: /Also create a key/ }),
    );
    const stored = window.sessionStorage.getItem("pk-new-license:djdl") ?? "";
    expect(stored).not.toContain("invites");
    expect(stored).not.toMatch(/pkey_|PK-/);
    expect(JSON.parse(stored).alsoKey).toBe(true);
    expect(loadDraft("djdl").invites).toBe(false);
  });

  it("sends the Delivery step back with the reason when the product can't invite after all", async () => {
    for (const [reason, words] of [
      ["auto_link_off", /doesn't add licenses by email/],
      ["identity_off", /Sign-in is off for this product/],
    ] as const) {
      cleanup();
      window.sessionStorage.clear();
      const { dialog } = await open({
        ...INVITING,
        [`POST ${API}/license/licenses`]: refusal(reason),
      });
      await choose(dialog, /^Pro/);
      await press(dialog, "Continue");
      await userEvent.type(within(dialog).getByLabelText(/^Email/), "g@x.io");
      await press(dialog, "Continue");
      await press(dialog, "Continue");
      await press(dialog, "Continue");
      await press(dialog, "Create and invite");
      await waitFor(() =>
        expect(heading(dialog).textContent).toContain("Delivery"),
      );
      expect(within(dialog).getAllByText(words).length).toBeGreaterThan(0);
      // The invitation is no longer offered.
      expect(
        within(dialog).queryByRole("radio", { name: /Email an invitation/ }),
      ).toBeNull();
    }
  });

  it("says under Email why invitations aren't offered when auto-link is off", async () => {
    const { dialog } = await open({
      [`${API}/license/licenses`]: {
        licenses: LICENSES,
        holders: { invitations: false, invitationsOff: "auto_link_off" },
      },
    });
    await choose(dialog, /^Pro/);
    await press(dialog, "Continue");
    await userEvent.type(within(dialog).getByLabelText(/^Email/), "g@x.io");
    await press(dialog, "Continue");
    await press(dialog, "Continue");
    expect(within(dialog).getByText(/Invitations aren't offered/)).toBeTruthy();
    expect(
      within(dialog).getByRole("radio", { name: /Email the key and show it/ }),
    ).toHaveProperty("ariaChecked", "true");
    expect(
      within(dialog).queryByRole("radio", { name: /Email an invitation/ }),
    ).toBeNull();
  });
});

describe("New license wizard: the invitation fix round (LX-27c.4 review)", () => {
  const reachDelivery = async (dialog: HTMLElement) => {
    await choose(dialog, /^Pro/);
    await press(dialog, "Continue");
    await userEvent.type(within(dialog).getByLabelText(/^Email/), "g@x.io");
    await press(dialog, "Continue");
    await press(dialog, "Continue");
  };
  const createAnswer = (delivered: Record<string, unknown>, key?: string) => ({
    [`POST ${API}/license/licenses`]: {
      licenseId: "lic_new",
      ...(key ? { key } : {}),
      delivered,
      license: ADA,
    },
  });
  const failed = createAnswer({ invite: "failed", reason: "provider_refused" });
  const toDone = async (dialog: HTMLElement) => {
    await reachDelivery(dialog);
    await press(dialog, "Continue");
    await press(dialog, "Create and invite");
    await waitFor(() =>
      expect(heading(dialog).textContent).toContain("Invitation not sent"),
    );
  };
  const problem = (status: number, body: Record<string, unknown>) =>
    new Response(JSON.stringify({ error: { code: "bad_request" }, ...body }), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("B1: a failed send says the license is waiting, and Create a key makes the one-time key", async () => {
    const { log, dialog } = await open({
      ...INVITING,
      ...failed,
      [`POST ${API}/license/licenses/lic_new/keys`]: {
        key: "PK-MADE-KEY",
        hash: "h",
        record: {},
      },
    });
    await toDone(dialog);
    expect(
      within(dialog).getByText(
        /The license is waiting for g@x\.io\. When they sign in with it, it's theirs\./,
      ),
    ).toBeTruthy();
    await userEvent.click(primary(dialog, "Create a key"));
    expect(await within(dialog).findByText("PK-MADE-KEY")).toBeTruthy();
    expect(GOT(log, "/lic_new/keys")).toHaveLength(1);
    // The key is the only copy: leaving waits for "I've stored it".
    expect(primary(dialog, "Done").getAttribute("aria-disabled")).toBe("true");
    expect(
      within(dialog).queryByRole("button", { name: "Create a key" }),
    ).toBeNull();
  });

  it("B1: no mail on the server offers no invitation, and says so", async () => {
    const { dialog } = await open({
      [`${API}/license/licenses`]: {
        licenses: LICENSES,
        holders: { invitations: false, invitationsOff: "no_mail" },
      },
    });
    await reachDelivery(dialog);
    expect(
      within(dialog).getByText(/email isn't set up on this Polaris Key server/),
    ).toBeTruthy();
    expect(
      within(dialog).queryByRole("radio", { name: /Email an invitation/ }),
    ).toBeNull();
  });

  it("B2: Done says things once", async () => {
    const sent = await open({
      ...INVITING,
      ...createAnswer({ invite: "sent" }),
    });
    await reachDelivery(sent.dialog);
    await press(sent.dialog, "Continue");
    await press(sent.dialog, "Create and invite");
    await waitFor(() =>
      expect(heading(sent.dialog).textContent).toContain("Invitation sent"),
    );
    expect(within(sent.dialog).queryByText(/^Invitation sent to/)).toBeNull();
    expect(
      within(sent.dialog).getByText(/is in their Polaris Locker library/),
    ).toBeTruthy();
    cleanup();
    window.sessionStorage.clear();
    const bad = await open({ ...INVITING, ...failed });
    await toDone(bad.dialog);
    expect(
      within(bad.dialog).queryByText("The invitation wasn't sent"),
    ).toBeNull();
    expect(within(bad.dialog).queryByText(/Try again\.$/)).toBeNull();
    expect(
      within(bad.dialog).queryByText("Sends the invitation again."),
    ).toBeNull();
  });

  it("M1/M2: the key box is inside the invitation card, and no key is said once", async () => {
    const { dialog } = await open(INVITING);
    await reachDelivery(dialog);
    const invite = within(dialog).getByRole("radio", {
      name: /Email an invitation/,
    });
    const box = within(dialog).getByRole("checkbox", {
      name: /Also create a key/,
    });
    expect(invite.parentElement!.contains(box)).toBe(true);
    expect(
      within(dialog).getByText(
        /g@x\.io signs in with g@x\.io to use it\. No key\./,
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("Shown once here, never emailed."),
    ).toBeTruthy();
  });

  it("M3: after a 429 Try again is aria-disabled with the wait; in_account is good news with no Try again", async () => {
    const wait = await open({
      ...INVITING,
      ...failed,
      [`POST ${API}/license/licenses/lic_new/send-invite`]: problem(429, {
        retryAfter: 412,
      }),
    });
    await toDone(wait.dialog);
    await userEvent.click(primary(wait.dialog, "Try again"));
    expect(
      await within(wait.dialog).findByText(
        "An email went to this license in the last 10 minutes.",
      ),
    ).toBeTruthy();
    expect(within(wait.dialog).queryByText("Sent a moment ago")).toBeNull();
    const again = primary(wait.dialog, "Try again");
    expect(again.getAttribute("aria-disabled")).toBe("true");
    expect(
      within(wait.dialog).getAllByText("Try again in 7 min.").length,
    ).toBeGreaterThan(0);
    cleanup();
    window.sessionStorage.clear();
    const acct = await open({
      ...INVITING,
      ...failed,
      [`POST ${API}/license/licenses/lic_new/send-invite`]: problem(409, {
        reason: "in_account",
      }),
    });
    await toDone(acct.dialog);
    await userEvent.click(primary(acct.dialog, "Try again"));
    expect(
      await within(acct.dialog).findByText(/already has it in their account/),
    ).toBeTruthy();
    expect(
      within(acct.dialog).queryByRole("button", { name: "Try again" }),
    ).toBeNull();
  });

  it("M4: a refused invitation refreshes the list so the next license doesn't offer it again", async () => {
    const { log, dialog } = await open({
      ...INVITING,
      [`POST ${API}/license/licenses`]: problem(422, {
        fields: ["delivery"],
        reason: "auto_link_off",
      }),
    });
    await reachDelivery(dialog);
    const reads = () =>
      log.calls.filter(
        (c) => c.method === "GET" && c.path.endsWith("/license/licenses"),
      ).length;
    const before = reads();
    await press(dialog, "Continue");
    await press(dialog, "Create and invite");
    await waitFor(() =>
      expect(heading(dialog).textContent).toContain("Delivery"),
    );
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it("N1/N4: a stored key-only choice maps to email-and-show, and an invitation retry needs no stored key", async () => {
    expect(
      deliveryOf({ ...EMPTY, who: "person", invites: true, delivery: "email" }),
    ).toBe("email-show");
    expect(
      deliveryOf({ ...EMPTY, who: "person", invites: true, delivery: null }),
    ).toBe("invite");
    const { dialog } = await open({
      ...INVITING,
      ...createAnswer({ invite: "failed", reason: "provider_refused" }, "PK-K"),
    });
    await reachDelivery(dialog);
    await userEvent.click(
      within(dialog).getByRole("checkbox", { name: /Also create a key/ }),
    );
    await press(dialog, "Continue");
    await press(dialog, "Create and invite");
    await waitFor(() =>
      expect(heading(dialog).textContent).toContain("Invitation not sent"),
    );
    // The key is on screen and not yet stored; resending touches no key, so Try again is open.
    expect(
      primary(dialog, "Try again").getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("N2: the Who step on an inviting product doesn't sell the key", async () => {
    const { dialog } = await open(INVITING);
    await choose(dialog, /^Pro/);
    await press(dialog, "Continue");
    expect(
      within(dialog).getByText(/They sign in with it to use the license/),
    ).toBeTruthy();
  });
});

describe("license channel picker in the wizard (P0-04, WIRE-CONTRACT-V3 §5.1)", () => {
  const channelRows = (names: string[]) => ({
    releases: [],
    channels: names.map((channel) => ({
      channel,
      releaseId: "v1",
      modifiedAt: null,
    })),
  });

  async function openChannels(routes: Record<string, unknown> = {}) {
    const { dialog } = await open(routes);
    await press(dialog, "Continue");
    await userEvent.type(within(dialog).getByLabelText(/^Email/), "g@x.io");
    await press(dialog, "Continue");
    await userEvent.click(
      within(dialog).getByRole("button", { name: /More options/ }),
    );
    await within(dialog).findAllByRole("group", { name: "Release tracks" });
    return within(dialog)
      .getAllByRole("group", { name: "Release tracks" })
      .at(-1)!;
  }

  it("offers dev with its hint, and not staging, for a product with no manual channels", async () => {
    const group = await openChannels();
    for (const name of ["stable", "beta", "dev", "pr"])
      expect(within(group).getByLabelText(name)).toBeTruthy();
    expect(
      within(group).getByText("Skips the version window and channel checks"),
    ).toBeTruthy();
    expect(within(group).queryByLabelText("staging")).toBeNull();
  });

  it("drops reserved and non-canonical manual names; a manual staging is listed once", async () => {
    const group = await openChannels({
      [`${API}/release/releases`]: channelRows([
        "stable",
        "beta",
        "dev",
        "pr",
        "Nightly",
        "staging",
      ]),
    });
    await waitFor(() =>
      expect(within(group).getAllByLabelText("staging")).toHaveLength(1),
    );
    expect(within(group).getAllByLabelText("dev")).toHaveLength(1);
    expect(within(group).queryByLabelText("Nightly")).toBeNull();
    expect(within(group).getAllByLabelText("pr")).toHaveLength(1);
  });
});
