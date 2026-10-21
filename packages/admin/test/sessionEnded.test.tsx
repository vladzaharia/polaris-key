import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api, setLoginRedirectForTests } from "../src/api.js";
import { clearSessionEnded } from "../src/console/shell/endedState.js";
import { boot, resetConsole } from "./consoleHarness.js";
import { expectNoAxeViolations } from "./coreTestUtils.js";

/**
 * "Your session ended", in place (SIGN-IN.md §3.12): a 401 marked expired while a page is open
 * covers the page with a dialog instead of leaving it, so unsaved input survives; Sign in again
 * happens in a second tab that tells this one.
 */

const EXPIRED = () =>
  new Response(null, { status: 401, headers: { "X-PKey-Session": "expired" } });

let redirect = vi.fn();

beforeEach(() => {
  resetConsole();
  redirect = vi.fn();
  setLoginRedirectForTests(redirect);
  clearSessionEnded();
});
afterEach(() => {
  cleanup();
  clearSessionEnded();
  vi.unstubAllGlobals();
});

async function endSession(): Promise<void> {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async () => EXPIRED());
  await act(async () => {
    await api.attention().catch(() => undefined);
  });
  vi.stubGlobal("fetch", real);
}

async function openPage(): Promise<HTMLInputElement> {
  boot("#/");
  await screen.findByRole("navigation", { name: "Console" });
  // Something the person typed that no request has saved.
  const draft = document.createElement("input");
  draft.setAttribute("aria-label", "Unsaved note");
  document.body.appendChild(draft);
  draft.value = "half a sentence";
  return draft;
}

describe("the session-ended overlay", () => {
  it("covers the page, keeps what was typed, and does not navigate away", async () => {
    const draft = await openPage();
    await endSession();
    const dialog = await screen.findByRole("alertdialog", {
      name: "Your session ended",
    });
    expect(
      within(dialog).getByText(/Changes you haven’t saved stay on this page/),
    ).toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
    expect(draft.value).toBe("half a sentence");
    expect(draft.isConnected).toBe(true);
    draft.remove();
  });

  it("Sign in again opens the sign-in card in a second tab that returns to the signed-in card", async () => {
    await openPage();
    await endSession();
    const dialog = await screen.findByRole("alertdialog");
    const link = within(dialog).getByRole("link", { name: "Sign in again" });
    const href = new URL(link.getAttribute("href")!, "http://localhost");
    expect(href.pathname).toBe("/manage/login");
    expect(href.searchParams.get("ended")).toBe("1");
    expect(href.searchParams.get("returnTo")).toBe("/manage/#/signed-in");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    // A click says what to do next, politely.
    await userEvent.click(link);
    expect(
      await within(dialog).findByText(/Sign in in the new tab/),
    ).toBeTruthy();
  });

  it("moves focus into the dialog; Escape and Not now leave the page as it is and return focus", async () => {
    await openPage();
    const trigger = await screen.findByRole("button", { name: "Account menu" });
    trigger.focus();
    await endSession();
    const dialog = await screen.findByRole("alertdialog");
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    // The next request that fails brings it back.
    await endSession();
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("has no axe violations", async () => {
    await openPage();
    await endSession();
    const dialog = await screen.findByRole("alertdialog");
    await expectNoAxeViolations(dialog);
  });

  it("carries on when /me loads again (a sign-in elsewhere)", async () => {
    await openPage();
    await endSession();
    await screen.findByRole("alertdialog");
    // Back on the tab: the shell reads /me, which works now.
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("the sign-in tab's message makes this page read the session again", async () => {
    const channels: { onmessage: (() => void) | null; close: () => void }[] =
      [];
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        onmessage: (() => void) | null = null;
        constructor() {
          channels.push(this);
        }
        postMessage(): void {}
        close(): void {
          channels.splice(channels.indexOf(this), 1);
        }
      },
    );
    await openPage();
    await endSession();
    await screen.findByRole("alertdialog");
    await waitFor(() => expect(channels.length).toBe(1));
    await act(async () => channels[0]!.onmessage?.());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});
