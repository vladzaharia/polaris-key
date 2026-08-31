import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AdminApiToken } from "../src/api.js";
import { setCsrf, setLoginRedirectForTests } from "../src/api.js";
import { resetCache } from "../src/context.js";
import { Toaster } from "../src/components/ui/index.js";
import { ApiTokens } from "../src/views/ApiTokens.js";

/**
 * The admin API-token roster (WP-13).
 *
 * These drive the view through a SCRIPTED FETCH rather than a mocked `api` module, unlike the
 * other view suites, for one reason: the properties that matter here are transport-shaped. That
 * the revoke is a `DELETE` carrying `X-PKey-CSRF`, and that the roster refetched after a mint
 * carries no secret, are claims about the bytes on the wire — a mocked `api.revokeApiToken`
 * would assert the console's intention and prove nothing about either.
 *
 * The stub also holds server-side STATE (`roster`), so "revoking updates the row" is exercised
 * end to end: the DELETE flips the fixture, the view reloads, and the badge changes because the
 * server said so rather than because the component optimistically guessed.
 */

const SECRET = "pkeya_bDh3Zm5rQ2xwTXcxdEo4WHZSNXlOc0FnRWJVaTdRb0s";

interface Call {
  url: string;
  init: RequestInit;
}

let calls: Call[] = [];
let roster: AdminApiToken[] = [];
/** What `POST /manage/api/tokens` answers with. Overridden per-test for the 422 case. */
let mintResponder: () => Response = () => json({}, 500);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TOKENS_PATH = "/manage/api/tokens";

function stubFetch(): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      const method = (init.method ?? "GET").toUpperCase();

      if (url === TOKENS_PATH && method === "GET")
        return json({ tokens: roster });
      if (url === TOKENS_PATH && method === "POST") return mintResponder();
      if (url.startsWith(`${TOKENS_PATH}/`) && method === "DELETE") {
        const id = decodeURIComponent(url.slice(TOKENS_PATH.length + 1));
        const row = roster.find((t) => t.id === id);
        if (!row) return json({ error: "not_found" }, 404);
        if (row.status === "revoked")
          return json({ error: "bad_request" }, 409);
        const revoked: AdminApiToken = {
          ...row,
          revokedAt: 1_750_200_000,
          status: "revoked",
        };
        roster = roster.map((t) => (t.id === id ? revoked : t));
        return json({ ok: true, token: revoked });
      }
      return json({ error: "not_found" }, 404);
    }),
  );
}

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

/** The row a successful mint adds to the roster — WITHOUT the secret, exactly as the roster
 *  endpoint would report it a moment later. */
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

function renderTokens() {
  return render(
    <Toaster>
      <ApiTokens />
    </Toaster>,
  );
}

/** The row for a token, by its label cell. */
function rowFor(label: string): HTMLElement {
  const cell = screen.getByText(label);
  const row = cell.closest("tr");
  if (!row) throw new Error(`no row for ${label}`);
  return row;
}

beforeEach(() => {
  resetCache();
  vi.clearAllMocks();
  setCsrf("csrf-abc");
  setLoginRedirectForTests(() => undefined);
  roster = [ACTIVE, EXPIRED, REVOKED];
  // The mint has the same side effect the server does: the row joins the roster, and the roster
  // never learns the secret. Whatever the console reloads afterwards comes from HERE.
  mintResponder = () => {
    roster = [...roster, MINTED];
    return json({ ok: true, token: MINTED, secret: SECRET }, 201);
  };
  stubFetch();
  // jsdom lacks these Radix-needed APIs.
  (
    Element.prototype as unknown as { hasPointerCapture: () => boolean }
  ).hasPointerCapture = () => false;
  (
    Element.prototype as unknown as { scrollIntoView: () => void }
  ).scrollIntoView = () => undefined;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCsrf("");
  setLoginRedirectForTests();
});

describe("API tokens roster", () => {
  it("lists tokens on the platform-scoped route with no product in the path", async () => {
    renderTokens();
    expect(await screen.findByText("CI bundle minter")).toBeTruthy();
    // Platform-scoped: no `/products/<slug>/` segment, because a token belongs to the
    // deployment rather than to whichever product the switcher happens to be showing.
    expect(calls[0]!.url).toBe("/manage/api/tokens");
    expect(calls[0]!.init.method ?? "GET").toBe("GET");
  });

  it("renders active, expired and revoked with distinct statuses", async () => {
    renderTokens();
    await screen.findByText("CI bundle minter");
    // Three lifecycle answers, three visibly different badges — the roster's triage value.
    expect(within(rowFor("CI bundle minter")).getByText("active")).toBeTruthy();
    expect(
      within(rowFor("Old release runner")).getByText("expired"),
    ).toBeTruthy();
    expect(
      within(rowFor("Leaked laptop token")).getByText("revoked"),
    ).toBeTruthy();
  });

  it("shows “never” for an unused token and a real stamp for a used one", async () => {
    renderTokens();
    await screen.findByText("CI bundle minter");
    // An unused machine credential is a finding, not missing data, so it is not an em-dash.
    expect(
      within(rowFor("Old release runner")).getByText("never"),
    ).toBeTruthy();
    expect(within(rowFor("CI bundle minter")).queryByText("never")).toBeNull();
    // Expiry is rendered for every row, including the one that already lapsed.
    const expired = new Date(EXPIRED.expiresAt * 1000).toLocaleString();
    expect(
      within(rowFor("Old release runner")).getByText(expired),
    ).toBeTruthy();
  });

  it("offers revoke for a live or expired token but not for an already-revoked one", async () => {
    renderTokens();
    await screen.findByText("CI bundle minter");
    expect(
      screen.getByRole("button", { name: "Revoke CI bundle minter" }),
    ).toBeTruthy();
    // Still revocable after expiry: the worker refuses only on `revoked_at IS NOT NULL`.
    expect(
      screen.getByRole("button", { name: "Revoke Old release runner" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Revoke Leaked laptop token" }),
    ).toBeNull();
  });

  it("shows the empty state when the platform holds no tokens", async () => {
    roster = [];
    renderTokens();
    expect(await screen.findByText("No API tokens")).toBeTruthy();
  });

  it("surfaces a load failure with a retry affordance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ message: "boom" }, 500)),
    );
    renderTokens();
    expect(await screen.findByText("Couldn’t load API tokens")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy();
  });
});

describe("minting a token", () => {
  it("shows the secret exactly once and loses it on close", async () => {
    const user = userEvent.setup();
    renderTokens();
    await screen.findByText("CI bundle minter");

    await user.click(screen.getByRole("button", { name: /New token/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Label/), "Nightly builder");
    await user.type(within(dialog).getByLabelText(/Expires in/), "90");
    await user.click(
      within(dialog).getByRole("button", { name: "Mint token" }),
    );

    // The plaintext is revealed once, in a panel that says so in as many words.
    const panel = await within(dialog).findByRole("status");
    expect(within(panel).getByText(SECRET)).toBeTruthy();
    expect(within(panel).getByText("API token minted")).toBeTruthy();
    expect(within(panel).getByText(/shown only once/i)).toBeTruthy();
    expect(
      within(panel).getByRole("button", { name: "Copy token" }),
    ).toBeTruthy();
    // The request carried what the form was told, and only that.
    const mint = calls.find((c) => (c.init.method ?? "") === "POST")!;
    expect(mint.url).toBe("/manage/api/tokens");
    expect(JSON.parse(mint.init.body as string)).toEqual({
      label: "Nightly builder",
      expiresInDays: 90,
    });

    // Closing unmounts the only component that ever held the secret.
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("does not carry the secret into the roster it reloads", async () => {
    const user = userEvent.setup();
    renderTokens();
    await screen.findByText("CI bundle minter");

    await user.click(screen.getByRole("button", { name: /New token/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Label/), "Nightly builder");
    await user.type(within(dialog).getByLabelText(/Expires in/), "90");
    await user.click(
      within(dialog).getByRole("button", { name: "Mint token" }),
    );
    await within(dialog).findByRole("status");

    // The mint reloads the roster from the server; the mint response's `token` is discarded
    // rather than spliced in, so the refreshed list is built purely from the roster endpoint —
    // which has no secret field to carry one.
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(screen.getAllByText("Nightly builder").length).toBeGreaterThan(0),
    );

    expect(document.body.textContent).not.toContain(SECRET);
    // And reopening the dialog gets a blank form, not the secret back: there is no state left
    // to re-show, which is the property "shown once" actually rests on.
    await user.click(screen.getByRole("button", { name: /New token/ }));
    const reopened = await screen.findByRole("dialog");
    expect(within(reopened).queryByText(SECRET)).toBeNull();
    expect(
      (within(reopened).getByLabelText(/Label/) as HTMLInputElement).value,
    ).toBe("");
  });

  it("surfaces a 422 against the field the server named", async () => {
    const user = userEvent.setup();
    mintResponder = () =>
      json(
        {
          error: { code: "bad_request", message: "invalid token request" },
          code: "bad_request",
          message: "invalid token request",
          fields: ["expiresInDays"],
        },
        422,
      );
    renderTokens();
    await screen.findByText("CI bundle minter");

    await user.click(screen.getByRole("button", { name: /New token/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Label/), "Nightly builder");
    // In range locally, so the form submits and the SERVER is what refuses it.
    await user.type(within(dialog).getByLabelText(/Expires in/), "90");
    await user.click(
      within(dialog).getByRole("button", { name: "Mint token" }),
    );

    const expiry = await within(dialog).findByLabelText(/Expires in/);
    await waitFor(() =>
      expect(expiry.getAttribute("aria-invalid")).toBe("true"),
    );
    const described = (expiry.getAttribute("aria-describedby") ?? "").split(
      " ",
    );
    const message = described
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(message).toMatch(/between 1 and 365/);
    // The error lands on the expiry field, not on the label.
    expect(
      within(dialog).getByLabelText(/Label/).getAttribute("aria-invalid"),
    ).toBeNull();
    // A rejected mint reveals nothing.
    expect(within(dialog).queryByRole("status")).toBeNull();
  });

  it("refuses a lifetime outside 1…365 before spending a request", async () => {
    const user = userEvent.setup();
    renderTokens();
    await screen.findByText("CI bundle minter");

    await user.click(screen.getByRole("button", { name: /New token/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Label/), "Too long");
    await user.type(within(dialog).getByLabelText(/Expires in/), "400");
    await user.click(
      within(dialog).getByRole("button", { name: "Mint token" }),
    );

    expect(await within(dialog).findByText(/between 1 and 365/)).toBeTruthy();
    expect(calls.some((c) => (c.init.method ?? "") === "POST")).toBe(false);
  });

  it("requires a lifetime — the form has no default to submit", async () => {
    // Mirrors the server: `expiresInDays` is mandatory precisely so nobody mints a credential
    // whose life they never chose. A pre-filled box would defeat that while looking helpful.
    const user = userEvent.setup();
    renderTokens();
    await screen.findByText("CI bundle minter");

    await user.click(screen.getByRole("button", { name: /New token/ }));
    const dialog = await screen.findByRole("dialog");
    expect(
      (within(dialog).getByLabelText(/Expires in/) as HTMLInputElement).value,
    ).toBe("");
    await user.type(within(dialog).getByLabelText(/Label/), "No expiry given");
    await user.click(
      within(dialog).getByRole("button", { name: "Mint token" }),
    );

    expect(await within(dialog).findByText(/between 1 and 365/)).toBeTruthy();
    expect(calls.some((c) => (c.init.method ?? "") === "POST")).toBe(false);
  });
});

describe("revoking a token", () => {
  it("confirms first, then DELETEs with the CSRF header and updates the row", async () => {
    const user = userEvent.setup();
    renderTokens();
    await screen.findByText("CI bundle minter");

    await user.click(
      screen.getByRole("button", { name: "Revoke CI bundle minter" }),
    );

    // Destructive actions in this console go through a ConfirmDialog, and nothing is sent until
    // it is confirmed.
    const confirm = await screen.findByRole("alertdialog");
    expect(
      within(confirm).getByText(/Revoke “CI bundle minter”\?/),
    ).toBeTruthy();
    expect(calls.some((c) => (c.init.method ?? "") === "DELETE")).toBe(false);

    await user.click(
      within(confirm).getByRole("button", { name: "Revoke token" }),
    );

    await waitFor(() =>
      expect(calls.some((c) => (c.init.method ?? "") === "DELETE")).toBe(true),
    );
    const del = calls.find((c) => (c.init.method ?? "") === "DELETE")!;
    expect(del.url).toBe("/manage/api/tokens/apitok_active01");
    expect((del.init.headers as Headers).get("X-PKey-CSRF")).toBe("csrf-abc");

    // The row survives (history is kept) but now reads revoked, and loses its revoke button.
    await waitFor(() =>
      expect(
        within(rowFor("CI bundle minter")).getByText("revoked"),
      ).toBeTruthy(),
    );
    expect(
      screen.queryByRole("button", { name: "Revoke CI bundle minter" }),
    ).toBeNull();
  });

  it("leaves the row alone when the confirm is dismissed", async () => {
    const user = userEvent.setup();
    renderTokens();
    await screen.findByText("CI bundle minter");

    await user.click(
      screen.getByRole("button", { name: "Revoke CI bundle minter" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.some((c) => (c.init.method ?? "") === "DELETE")).toBe(false);
    expect(within(rowFor("CI bundle minter")).getByText("active")).toBeTruthy();
  });
});
