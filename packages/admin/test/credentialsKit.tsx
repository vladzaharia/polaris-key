/**
 * Shared steps for the credential editors' tests (`channelSetup`, `outletCredentials`): reset the
 * console around each test, open the set drawer, open a row's action, pick a select option, run
 * axe, and the Google key's PUT body.
 */

import { afterEach, beforeEach, expect, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resetConsole } from "./consoleHarness.js";
import { writes, type Call } from "./distributionFixture.js";

/** Reset the console before each test and unmount after it. */
export function resetAround(): void {
  beforeEach(() => resetConsole());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
}

export async function pick(
  container: HTMLElement,
  name: RegExp,
  option: RegExp,
): Promise<void> {
  await userEvent.click(within(container).getByRole("combobox", { name }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

/** Click "Set credential…" and return the drawer it opens. */
export async function openSetDrawer(): Promise<HTMLElement> {
  await userEvent.click(
    screen.getByRole("button", { name: "Set credential…" }),
  );
  return screen.findByRole("dialog", { name: "Set a channel credential" });
}

/** Open a row's action menu and choose an item. */
export async function rowAction(id: string, item: string): Promise<void> {
  await userEvent.click(
    screen.getByRole("button", { name: `Actions for ${id}` }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
}

/** Fill the Google key form (its JSON file and its package pin). */
export async function fillGoogleKey(drawer: HTMLElement): Promise<void> {
  await userEvent.type(within(drawer).getByLabelText(/JSON key file/), "{{}");
  const pin = within(drawer).getByLabelText(/Google Play package name/);
  expect(pin.getAttribute("inputmode")).toBe("text");
  await userEvent.type(pin, "gg.acme.djdl");
}

/** The one PUT a Google key sends. */
export async function expectGoogleKeyWrite(calls: Call[]): Promise<void> {
  await waitFor(() =>
    expect(writes(calls)).toEqual([
      expect.objectContaining({
        body: {
          kind: "google-service-account",
          value: "{}",
          pin: "gg.acme.djdl",
          outletId: null,
        },
      }),
    ]),
  );
}
