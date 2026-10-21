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

/**
 * The next request meets a marked 401. It is held, not failed: returns the promise of its eventual
 * outcome, and the real `fetch` to put back when the "sign-in" happens.
 */
async function endSession(): Promise<{
  held: Promise<unknown>;
  restore: () => void;
}> {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async () => EXPIRED());
  let held!: Promise<unknown>;
  await act(async () => {
    held = api.attention().then(
      (v) => ({ ok: v }),
      (e: unknown) => ({ err: e }),
    );
    await screen.findByRole("alertdialog", { name: "Your session ended" });
  });
  return { held, restore: () => vi.stubGlobal("fetch", real) };
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

  it("moves focus into the dialog; Escape leaves the page as it is, returns focus and fails the held request", async () => {
    await openPage();
    const trigger = await screen.findByRole("button", { name: "Account menu" });
    trigger.focus();
    const { held, restore } = await endSession();
    const dialog = await screen.findByRole("alertdialog");
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    // "Not now": the request that was waiting fails with its 401, as it would have.
    expect(await held).toMatchObject({ err: { status: 401 } });
    // The next request that meets the 401 brings the overlay back; Not now is the same.
    const again = await endSession();
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await again.held).toMatchObject({ err: { status: 401 } });
    restore();
    again.restore();
  });

  it("has no axe violations", async () => {
    await openPage();
    const { held } = await endSession();
    const dialog = await screen.findByRole("alertdialog");
    await expectNoAxeViolations(dialog);
    await userEvent.keyboard("{Escape}");
    await held;
  });

  it("carries on when /me loads again: the held request is sent again and succeeds", async () => {
    await openPage();
    const { held, restore } = await endSession();
    // The person signed in in the other tab. Back on this one the shell reads /me, which works now.
    restore();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await held).toHaveProperty("ok");
  });

  it("the replay carries the fresh CSRF token", async () => {
    await openPage();
    const real = globalThis.fetch;
    const seen: (string | null)[] = [];
    let first = true;
    vi.stubGlobal(
      "fetch",
      async (url: RequestInfo | URL, init?: RequestInit) => {
        if (
          String(url).includes("/manage/api/products/djdl/license/licenses")
        ) {
          seen.push(new Headers(init?.headers).get("X-PKey-CSRF"));
          if (first) {
            first = false;
            return EXPIRED();
          }
          return new Response("{}", { status: 200 });
        }
        return real(url, init);
      },
    );
    let held!: Promise<unknown>;
    await act(async () => {
      held = api
        .createLicense("djdl", { name: "x", email: "x@x.io" })
        .catch((e: unknown) => e);
      await screen.findByRole("alertdialog");
    });
    // The other tab signed in, so /me answers with a new session's token.
    const me = await (await real("/manage/api/me")).json();
    vi.stubGlobal(
      "fetch",
      async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).includes("/manage/api/me"))
          return new Response(JSON.stringify({ ...me, csrf: "fresh-token" }), {
            status: 200,
          });
        if (String(url).includes("/license/licenses")) {
          seen.push(new Headers(init?.headers).get("X-PKey-CSRF"));
          return new Response("{}", { status: 200 });
        }
        return real(url, init);
      },
    );
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await held;
    expect(seen).toEqual(["csrf-token", "fresh-token"]);
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
    const { held, restore } = await endSession();
    await waitFor(() => expect(channels.length).toBe(1));
    restore();
    await act(async () => channels[0]!.onmessage?.());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await held).toHaveProperty("ok");
  });
});
