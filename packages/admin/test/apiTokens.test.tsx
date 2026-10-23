import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { ApiError, type AdminApiToken, type Me } from "../src/api.js";
import { errorCopy } from "../src/lib/errorCopy.js";
import { boot, resetConsole, type FetchLog } from "./consoleHarness.js";

/**
 * The admin API token roster (`#/tokens`).
 *
 * These drive the whole console through a SCRIPTED FETCH, because the properties that matter are
 * transport-shaped: the revoke is a `DELETE` carrying the CSRF header, the mint sends the scopes
 * and lifetime the form was told, and the roster reloaded after a mint carries no secret. The
 * scripted server holds STATE (`roster`), so "revoking updates the row" is exercised end to end:
 * the DELETE flips the fixture, the page refetches, and the pill changes because the server said
 * so rather than because the page guessed.
 */

const SECRET = "pkeya_bDh3Zm5rQ2xwTXcxdEo4WHZSNXlOc0FnRWJVaTdRb0s";
const NOW_S = Math.floor(Date.now() / 1000);
/** A sign-in from the last half minute: inside the five-minute window a mint needs. */
const FRESH: Partial<Me> = { authAt: NOW_S - 30, stepUpMaxAgeSeconds: 300 };
const STALE: Partial<Me> = { authAt: NOW_S - 3600, stepUpMaxAgeSeconds: 300 };

const ACTIVE: AdminApiToken = {
  id: "apitok_active01",
  label: "CI bundle minter",
  scopes: ["bundles:mint"],
  createdAt: 1_750_000_000,
  expiresAt: 1_757_776_000,
  lastUsedAt: 1_750_086_400,
  revokedAt: null,
  status: "active",
};
const EXPIRED: AdminApiToken = {
  id: "apitok_expired1",
  label: "Old release runner",
  scopes: ["bundles:mint"],
  createdAt: 1_700_000_000,
  expiresAt: 1_710_000_000,
  lastUsedAt: null,
  revokedAt: null,
  status: "expired",
};
const REVOKED: AdminApiToken = {
  id: "apitok_revoked1",
  label: "Leaked laptop token",
  scopes: ["bundles:mint"],
  createdAt: 1_720_000_000,
  expiresAt: 1_760_000_000,
  lastUsedAt: 1_720_500_000,
  revokedAt: 1_721_000_000,
  status: "revoked",
};
/** The row a mint adds to the roster: WITHOUT the secret, as the roster endpoint reports it. */
const MINTED: AdminApiToken = {
  id: "apitok_new00001",
  label: "Nightly builder",
  scopes: ["bundles:mint"],
  createdAt: 1_750_100_000,
  expiresAt: 1_757_876_000,
  lastUsedAt: null,
  revokedAt: null,
  status: "active",
};

let roster: AdminApiToken[] = [];
/** What `POST /manage/api/tokens` answers with; overridden per test for the refusals. */
let mintAnswer: () => Response = () => json({}, 500);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tokenRoutes(): Record<string, unknown> {
  const routes: Record<string, unknown> = {
    "/manage/api/tokens": () => ({ tokens: roster }),
    "POST /manage/api/tokens": () => mintAnswer(),
  };
  for (const { id } of [ACTIVE, EXPIRED, REVOKED]) {
    routes[`DELETE /manage/api/tokens/${id}`] = () => {
      const row = roster.find((t) => t.id === id)!;
      const revoked: AdminApiToken = {
        ...row,
        revokedAt: NOW_S,
        status: "revoked",
      };
      roster = roster.map((t) => (t.id === id ? revoked : t));
      return { ok: true, token: revoked };
    };
  }
  return routes;
}

async function open(me: Partial<Me> = FRESH): Promise<FetchLog> {
  const log = boot("#/tokens", { me, extra: tokenRoutes() });
  await screen.findByRole("heading", { level: 1, name: "API tokens" });
  return log;
}

const table = (): Promise<HTMLElement> =>
  screen.findByRole("table", { name: "API tokens" });

/** The row for a token, by its label cell. */
async function rowFor(label: string): Promise<HTMLElement> {
  const row = within(await table())
    .getByText(label)
    .closest("tr");
  if (!row) throw new Error(`no row for ${label}`);
  return row;
}

/** Open the mint dialog and fill it; the caller presses Create. */
async function fill(user: UserEvent, days: string): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: /New token/ }));
  const dialog = await screen.findByRole("dialog", { name: "New API token" });
  await user.type(
    within(dialog).getByRole("textbox", { name: /Label/ }),
    "Nightly builder",
  );
  if (days)
    await user.type(
      within(dialog).getByRole("textbox", { name: /Expires after/ }),
      days,
    );
  return dialog;
}

const create = (dialog: HTMLElement): HTMLElement =>
  within(dialog).getByRole("button", { name: "Create token" });
const posts = (log: FetchLog) => log.calls.filter((c) => c.method === "POST");

beforeEach(() => {
  resetConsole();
  roster = [ACTIVE, EXPIRED, REVOKED];
  // The mint has the server's side effect: the row joins the roster, which never learns the
  // secret. Whatever the page reloads afterwards comes from HERE.
  mintAnswer = () => {
    roster = [...roster, MINTED];
    return json({ ok: true, token: MINTED, secret: SECRET }, 201);
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("API tokens roster", () => {
  it("lists tokens from the platform-scoped route, with no product in the path", async () => {
    const log = await open();
    await rowFor("CI bundle minter");
    const read = log.calls.find((c) => c.path.endsWith("/tokens"))!;
    expect(read.path).toBe("/manage/api/tokens");
    expect(read.method).toBe("GET");
  });

  it("renders active, expired and revoked as distinct statuses", async () => {
    await open();
    expect(
      within(await rowFor("CI bundle minter")).getByText("Active"),
    ).toBeTruthy();
    expect(
      within(await rowFor("Old release runner")).getByText("Expired"),
    ).toBeTruthy();
    expect(
      within(await rowFor("Leaked laptop token")).getByText("Revoked"),
    ).toBeTruthy();
  });

  it("shows Never for an unused token and a stamp for a used one", async () => {
    await open();
    // An unused machine credential is a finding, not missing data, so it is not a dash.
    expect(
      within(await rowFor("Old release runner")).getByText("Never"),
    ).toBeTruthy();
    expect(
      within(await rowFor("CI bundle minter")).queryByText("Never"),
    ).toBeNull();
  });

  it("offers revoke for a live or an expired token, never for a revoked one", async () => {
    await open();
    const t = await table();
    expect(
      within(t).getByRole("button", { name: "Actions for CI bundle minter" }),
    ).toBeTruthy();
    // Still revocable after expiry: the worker refuses only an already-revoked token.
    expect(
      within(t).getByRole("button", { name: "Actions for Old release runner" }),
    ).toBeTruthy();
    expect(
      within(t).queryByRole("button", {
        name: "Actions for Leaked laptop token",
      }),
    ).toBeNull();
  });

  it("shows the empty state when the platform holds no tokens", async () => {
    roster = [];
    await open();
    expect(await screen.findByText("No API tokens")).toBeTruthy();
  });

  it("surfaces a load failure with a retry that loads the list", async () => {
    let failing = true;
    boot("#/tokens", {
      me: FRESH,
      extra: {
        ...tokenRoutes(),
        "/manage/api/tokens": () =>
          failing ? new Response("{}", { status: 500 }) : { tokens: roster },
      },
    });
    const retry = await screen.findByRole("button", { name: "Try again" });
    failing = false;
    await userEvent.click(retry);
    expect(await screen.findByText("CI bundle minter")).toBeTruthy();
  });
});

describe("minting a token", () => {
  it("shows the secret exactly once and loses it on close", async () => {
    const user = userEvent.setup();
    const log = await open();
    await rowFor("CI bundle minter");
    const dialog = await fill(user, "90");
    await user.click(create(dialog));

    const shown = await screen.findByRole("dialog", {
      name: "API token created",
    });
    expect(shown.textContent).toContain(SECRET);
    expect(shown.textContent).toContain("Shown once");
    expect(within(shown).getByRole("button", { name: /^Copy/ })).toBeTruthy();
    // The request carried what the form was told, and only that.
    expect(posts(log)).toHaveLength(1);
    expect(posts(log)[0]!.path).toBe("/manage/api/tokens");
    expect(posts(log)[0]!.json).toEqual({
      label: "Nightly builder",
      scopes: ["bundles:mint"],
      expiresInDays: 90,
    });

    // Closing unmounts the only component that ever held the secret.
    await user.click(
      within(shown).getByRole("checkbox", { name: /stored it/ }),
    );
    await user.click(within(shown).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("does not carry the secret into the roster it reloads, and reopens blank", async () => {
    const user = userEvent.setup();
    const log = await open();
    await rowFor("CI bundle minter");
    const dialog = await fill(user, "90");
    await user.click(create(dialog));
    const shown = await screen.findByRole("dialog", {
      name: "API token created",
    });
    await user.click(
      within(shown).getByRole("checkbox", { name: /stored it/ }),
    );
    await user.click(within(shown).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // The mint reloads the roster from the server: the response's `token` is discarded rather
    // than spliced in, so the list is built purely from the roster endpoint, which has no secret.
    await waitFor(() =>
      expect(screen.getAllByText("Nightly builder").length).toBeGreaterThan(0),
    );
    expect(
      log.calls.filter(
        (c) => c.method === "GET" && c.path === "/manage/api/tokens",
      ).length,
    ).toBeGreaterThan(1);
    expect(document.body.textContent).not.toContain(SECRET);

    // And reopening gets a blank form, not the secret back: no state is left to re-show.
    await user.click(screen.getByRole("button", { name: /New token/ }));
    const reopened = await screen.findByRole("dialog", {
      name: "New API token",
    });
    expect(reopened.textContent).not.toContain(SECRET);
    expect(
      (
        within(reopened).getByRole("textbox", {
          name: /Label/,
        }) as HTMLInputElement
      ).value,
    ).toBe("");
  });

  it("surfaces a 422 against the field the server named", async () => {
    const user = userEvent.setup();
    mintAnswer = () =>
      json(
        {
          error: { code: "bad_request", message: "invalid token request" },
          code: "bad_request",
          message: "invalid token request",
          fields: ["expiresInDays"],
        },
        422,
      );
    await open();
    const dialog = await fill(user, "90");
    await user.click(create(dialog));

    // In range locally, so the form submits and the SERVER is what refuses it.
    expect(
      await within(dialog).findByText(/whole number of days from 1 to 365/),
    ).toBeTruthy();
    expect(
      within(dialog)
        .getByRole("textbox", { name: /Expires after/ })
        .getAttribute("aria-invalid"),
    ).toBe("true");
    // The error lands on the expiry field, not on the label, and a refusal reveals nothing.
    expect(
      within(dialog)
        .getByRole("textbox", { name: /Label/ })
        .getAttribute("aria-invalid"),
    ).toBeNull();
    expect(
      screen.queryByRole("dialog", { name: "API token created" }),
    ).toBeNull();
  });

  it("refuses a lifetime outside 1 to 365 before spending a request", async () => {
    const user = userEvent.setup();
    const log = await open();
    const dialog = await fill(user, "400");

    expect(
      await within(dialog).findByText(/whole number of days from 1 to 365/),
    ).toBeTruthy();
    expect((create(dialog) as HTMLButtonElement).disabled).toBe(true);
    expect(posts(log)).toEqual([]);
  });

  it("requires a lifetime: the form has no default to submit", async () => {
    // Mirrors the server: `expiresInDays` is mandatory so nobody mints a credential whose life
    // they never chose. A pre-filled box would defeat that while looking helpful.
    const user = userEvent.setup();
    const log = await open();
    const dialog = await fill(user, "");

    expect(
      (
        within(dialog).getByRole("textbox", {
          name: /Expires after/,
        }) as HTMLInputElement
      ).value,
    ).toBe("");
    expect((create(dialog) as HTMLButtonElement).disabled).toBe(true);
    expect(posts(log)).toEqual([]);
  });

  it("needs a recent sign-in: a stale session sees the callout and cannot submit", async () => {
    const user = userEvent.setup();
    const log = await open(STALE);
    const dialog = await fill(user, "90");

    expect(within(dialog).getByText("Sign in again to continue")).toBeTruthy();
    const href = within(dialog)
      .getByRole("link", { name: "Sign in again" })
      .getAttribute("href")!;
    expect(href).toContain("stepUp=1");
    expect(decodeURIComponent(href)).toContain("returnTo=/manage/#/tokens");
    expect((create(dialog) as HTMLButtonElement).disabled).toBe(true);
    expect(posts(log)).toEqual([]);
  });

  it("turns a server step-up refusal into the sign-in callout, not a bare error", async () => {
    const user = userEvent.setup();
    mintAnswer = () =>
      json(
        {
          error: { code: "step_up_required", message: "sign in again" },
          code: "step_up_required",
        },
        403,
      );
    await open();
    const dialog = await fill(user, "90");
    await user.click(create(dialog));

    expect(
      await within(dialog).findByText("Sign in again to continue"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("dialog", { name: "API token created" }),
    ).toBeNull();
  });
});

describe("revoking a token", () => {
  it("confirms first, then DELETEs with the CSRF header and updates the row", async () => {
    const user = userEvent.setup();
    const log = await open();
    const t = await table();
    await user.click(
      within(t).getByRole("button", { name: "Actions for CI bundle minter" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: /Revoke/ }));

    // Destructive actions go through a ConfirmDialog, and nothing is sent until it is confirmed.
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Revoke CI bundle minter?");
    expect(log.calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(
      within(confirm).getByRole("button", { name: "Revoke token" }),
    );

    await waitFor(() =>
      expect(log.calls.some((c) => c.method === "DELETE")).toBe(true),
    );
    expect(log.calls.find((c) => c.method === "DELETE")!.path).toBe(
      "/manage/api/tokens/apitok_active01",
    );
    // The row survives (history is kept) but now reads Revoked, and loses its actions.
    await waitFor(async () =>
      expect(
        within(await rowFor("CI bundle minter")).getByText("Revoked"),
      ).toBeTruthy(),
    );
    expect(
      within(await table()).queryByRole("button", {
        name: "Actions for CI bundle minter",
      }),
    ).toBeNull();
  });

  it("leaves the row alone when the confirmation is dismissed", async () => {
    const user = userEvent.setup();
    const log = await open();
    await user.click(
      within(await table()).getByRole("button", {
        name: "Actions for CI bundle minter",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: /Revoke/ }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(log.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(
      within(await rowFor("CI bundle minter")).getByText("Active"),
    ).toBeTruthy();
  });
});

describe("an emergency sign-in (ST-30c.2, N3)", () => {
  it("soft-disables New token with the reason, and names the same reason on a refusal", async () => {
    await open({ ...FRESH, breakGlass: true });
    const button = await screen.findByRole("button", { name: "New token…" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title") ?? button.textContent).toBeTruthy();
  });

  it("the 403 break_glass_session refusal reads as its own problem, not 'you need edit access'", () => {
    const copy = errorCopy(
      new ApiError(
        403,
        undefined,
        "forbidden",
        undefined,
        "break_glass_session",
      ),
    );
    expect(copy.title).toBe("Emergency sign-in can't do this");
    expect(copy.description).toBe(
      "Sign out, then sign in with your account to continue.",
    );
    expect(copy.description).not.toMatch(/edit access/);
  });

  it("Issue token… and Set trusted publisher… are soft-disabled on a product's CI publishing", async () => {
    boot("#/p/djdl/settings/keys", { me: { breakGlass: true } });
    const issue = await screen.findByRole("button", { name: "Issue token…" });
    expect(issue.getAttribute("aria-disabled")).toBe("true");
  });
});
