import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PENDING, resetConsole } from "./consoleHarness.js";
import { API, bootLicense, LICENSES } from "./licenseFixture.js";

/**
 * The product's first license is a moment (EXPERIENCE.md §0.7, S-24 §8.5; MO-11): the New license
 * dialog's Done step carries the success check and sparks and a **Try it** to the SDK quick start,
 * once per product (a stored key), and only when the product had no license before. Through the
 * whole console, so the license list, the create and the invalidation are the real ones.
 */

beforeEach(resetConsole);
afterEach(cleanup);

const KEY = "pk-moment:first-license:djdl";

async function createOne(name: string): Promise<HTMLElement> {
  const dialog = await screen.findByRole("dialog", { name: "Create license" });
  await userEvent.type(within(dialog).getByLabelText(/^Name/), name);
  await userEvent.type(within(dialog).getByLabelText(/^Email/), "a@x.io");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Continue to terms" }),
  );
  await within(dialog).findByText("Effective policy");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Create license" }),
  );
  await within(dialog).findByText("PK-NEWKEY-ONESHOT");
  return dialog;
}

async function openDialog(): Promise<void> {
  const buttons = await screen.findAllByRole("button", {
    name: "Create license",
  });
  await userEvent.click(buttons[0]!);
}

describe("the first license (EXPERIENCE §0.7)", () => {
  it("Done carries the moment and Try it when the product had no license, once", async () => {
    bootLicense("#/p/djdl/license/licenses", {
      routes: { [`${API}/license/licenses`]: { licenses: [] } },
    });
    await openDialog();
    const dialog = await createOne("Grace Hopper");
    const moment = dialog.querySelector<HTMLElement>(
      '[data-moment="first-license:djdl"]',
    )!;
    expect(within(moment).getByText("DJDL's first license")).toBeTruthy();
    expect(
      moment.querySelector(".pk-celebration")!.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(window.localStorage.getItem(KEY)).not.toBeNull();
    // Try it waits for the key to be stored, like every other way out.
    const tryIt = within(dialog).getByRole("button", { name: "Try it" });
    expect(tryIt.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(within(dialog).getByLabelText(/I've stored it/));
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create another" }),
    );
    // The second license is not a first: no moment, no Try it.
    const again = await createOne("Ada Lovelace");
    expect(again.querySelector("[data-moment]")).toBeNull();
    expect(within(again).queryByRole("button", { name: "Try it" })).toBeNull();
  });

  it("Try it opens Overview, where the SDK quick start is", async () => {
    bootLicense("#/p/djdl/license/licenses", {
      routes: { [`${API}/license/licenses`]: { licenses: [] } },
    });
    await openDialog();
    const dialog = await createOne("Grace Hopper");
    await userEvent.click(within(dialog).getByLabelText(/I've stored it/));
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Try it" }),
    );
    await waitFor(() => expect(window.location.hash).toBe("#/p/djdl"));
    // …and lands on the SDK chooser, as the palette's "SDK quick start" does.
    await waitFor(() =>
      expect(document.activeElement?.id).toBe("sdk-quick-start"),
    );
  });

  it("licenses still loading when Create is pressed is not an empty list: no moment", async () => {
    bootLicense("#/p/djdl/license/licenses", {
      routes: { [`${API}/license/licenses`]: PENDING },
    });
    await openDialog();
    const dialog = await createOne("Grace Hopper");
    expect(dialog.querySelector("[data-moment]")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Try it" })).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("a product that already has licenses gets no moment", async () => {
    bootLicense("#/p/djdl/license/licenses");
    await screen.findByText(LICENSES[0]!.name);
    await openDialog();
    const dialog = await createOne("Grace Hopper");
    expect(dialog.querySelector("[data-moment]")).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("a product whose first license was already celebrated in this browser gets none", async () => {
    window.localStorage.setItem(KEY, "1");
    bootLicense("#/p/djdl/license/licenses", {
      routes: { [`${API}/license/licenses`]: { licenses: [] } },
    });
    await openDialog();
    const dialog = await createOne("Grace Hopper");
    expect(dialog.querySelector("[data-moment]")).toBeNull();
  });
});
