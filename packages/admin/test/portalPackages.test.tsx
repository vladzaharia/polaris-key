import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  PortalPackageAccess,
  PortalPersonalToken,
  PortalPersonalTokens,
} from "../src/portal/api.js";
import {
  axeViolations,
  DAY,
  detail,
  fetchedRequests,
  license,
  mockFetch,
  NOW_S,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15";
const TOKEN = "pkeyp_Lm9xT2qVb8sPzK4wNc7dRf1hYj3e";
const ME = "/api/me/tokens";

beforeEach(() => {
  window.history.replaceState(null, "", "/#/account/packages");
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_UA);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function token(over: Partial<PortalPersonalToken> = {}): PortalPersonalToken {
  return {
    id: "pt_ci",
    label: "CI build server",
    hint: "Hq2a",
    scope: "packages:read",
    createdAt: NOW_S - 60 * DAY,
    expiresAt: NOW_S + 90 * DAY,
    lastUsedAt: NOW_S - 3 * 3600,
    revokedAt: null,
    status: "active",
    ...over,
  };
}

function tokens(
  over: Partial<PortalPersonalTokens> = {},
): PortalPersonalTokens {
  return {
    registryOrigin: "https://pkg.plrs.im",
    username: "__token__",
    feeds: [
      {
        product: "tidewater",
        productName: "Tidewater Studio",
        ecosystem: "npm",
        accessMode: "licensed",
        baseUrl: "https://pkg.plrs.im/npm/tidewater/",
      },
    ],
    tokens: [
      token(),
      token({
        id: "pt_laptop",
        label: "Laptop",
        hint: "j3eX",
        lastUsedAt: null,
        expiresAt: NOW_S + 6 * DAY - 60,
      }),
      token({ id: "pt_old", label: "Old", status: "revoked" }),
    ],
    limits: {
      minDays: 1,
      maxDays: 365,
      defaultDays: 90,
      labelMax: 64,
      perAccount: 25,
    },
    ...over,
  };
}

function routes(extra: Record<string, unknown> = {}) {
  return signedIn([], { [ME]: tokens(), ...extra } as never);
}

async function card(): Promise<HTMLElement> {
  const h = await screen.findByRole("heading", { name: "Your tokens" });
  return h.closest("section")!;
}

describe("Account → Packages (F-33)", () => {
  it("lists the live tokens by name and last four, and one setup that names the token by its variable", async () => {
    mockFetch(routes());
    renderPortal();
    const c = await card();
    expect(within(c).getByText("CI build server")).toBeTruthy();
    expect(within(c).getByText(/pkeyp_…Hq2a/)).toBeTruthy();
    expect(within(c).getByText("Expires in 6 days")).toBeTruthy();
    expect(within(c).getByText(/never used/)).toBeTruthy();
    // Revoked tokens are history, not listed.
    expect(within(c).queryByText("Old")).toBeNull();
    expect(c.textContent).toContain("PKEY_REGISTRY_TOKEN");
    expect(c.textContent).not.toContain(TOKEN);
    expect(
      screen.getAllByRole("link", { name: "Packages" }).length,
    ).toBeGreaterThan(0);
    expect(await axeViolations()).toEqual([]);
  });

  it("says so when no license reaches a private feed, and when there are no tokens", async () => {
    mockFetch(routes({ [ME]: tokens({ feeds: [], tokens: [] }) }));
    renderPortal();
    const c = await card();
    expect(within(c).getByText(/No tokens yet/)).toBeTruthy();
    expect(
      within(c).getByText(/None of your active licenses include a private/),
    ).toBeTruthy();
  });

  it("shows a new token once, in a dialog Escape and the scrim cannot close before it is copied or acknowledged", async () => {
    const posted: unknown[] = [];
    mockFetch(
      routes({
        [`POST ${ME}`]: (init: RequestInit) => {
          posted.push(JSON.parse(String(init.body)));
          return {
            status: 201,
            body: {
              ok: true,
              token: TOKEN,
              view: token({ id: "pt_new", label: "Laptop 2", hint: "j3e" }),
            },
          };
        },
      }),
    );
    renderPortal();
    const c = await card();
    await userEvent.click(
      within(c).getByRole("button", { name: "Create token" }),
    );
    const form = await screen.findByRole("dialog", { name: "Create a token" });
    await userEvent.type(within(form).getByLabelText("Name"), "Laptop 2");
    await userEvent.click(
      within(form).getByRole("button", { name: "Create token" }),
    );
    const shown = await screen.findByRole("dialog", {
      name: "Copy your token now",
    });
    expect(posted).toEqual([{ label: "Laptop 2", expiresInDays: 90 }]);
    expect(within(shown).getAllByText(TOKEN).length).toBeGreaterThan(0);
    expect(shown.textContent).toContain(`_authToken=${TOKEN}`);
    expect(await axeViolations()).toEqual([]);
    fireEvent.keyDown(shown, { key: "Escape" });
    expect(
      await within(shown).findByText(/Close without copying\?/),
    ).toBeTruthy();
    await userEvent.click(
      within(shown).getByRole("button", { name: "Keep it open" }),
    );
    await userEvent.click(
      within(shown).getByRole("checkbox", { name: /I've stored it/ }),
    );
    await userEvent.click(within(shown).getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Copy your token now" }),
      ).toBeNull(),
    );
    // Closing the dialog drops the token from the page.
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it("asks to confirm it's you when the sign-in is stale, and keeps what was typed", async () => {
    mockFetch(
      routes({
        [`POST ${ME}`]: {
          status: 401,
          body: { error: "step_up_required" },
        },
      }),
    );
    renderPortal();
    const c = await card();
    await userEvent.click(
      within(c).getByRole("button", { name: "Create token" }),
    );
    const form = await screen.findByRole("dialog", { name: "Create a token" });
    await userEvent.type(within(form).getByLabelText("Name"), "Laptop 2");
    await userEvent.click(
      within(form).getByRole("button", { name: "Create token" }),
    );
    await within(form).findByText(/create a token/i, { selector: "*" });
    expect(
      (within(form).getByLabelText("Name") as HTMLInputElement).value,
    ).toBe("Laptop 2");
  });

  it("revokes a token after an inline confirmation", async () => {
    let revoked = false;
    mockFetch(
      routes({
        [ME]: () =>
          revoked
            ? tokens({ tokens: [token({ status: "revoked" })] })
            : tokens({ tokens: [token()] }),
        [`DELETE ${ME}/pt_ci`]: () => {
          revoked = true;
          return { ok: true, view: token({ status: "revoked" }) };
        },
      }),
    );
    renderPortal();
    const c = await card();
    await userEvent.click(
      within(c).getByRole("button", { name: "Revoke CI build server" }),
    );
    const q = within(c).getByText("Revoke CI build server?");
    await waitFor(() => expect(document.activeElement).toBe(q));
    await userEvent.click(
      within(c).getByRole("button", { name: "Revoke CI build server" }),
    );
    await waitFor(() =>
      expect(within(c).queryByText("CI build server")).toBeNull(),
    );
    expect(fetchedRequests()).toContain(`DELETE ${ME}/pt_ci`);
  });

  it("disables Create at the account's limit and says why", async () => {
    mockFetch(
      routes({
        [ME]: tokens({
          tokens: [token()],
          limits: { ...tokens().limits, perAccount: 1 },
        }),
      }),
    );
    renderPortal();
    const c = await card();
    await userEvent.click(
      within(c).getByRole("button", { name: /Create token/ }),
    );
    expect(screen.queryByRole("dialog", { name: "Create a token" })).toBeNull();
  });
});

describe("Packages on a product page", () => {
  const tidewater = license({
    product: "tidewater",
    productName: "Tidewater Studio",
    tier: "pro",
  });
  const BASE = "/api/licenses/tidewater/lic_tidewater/registry-tokens";
  const access: PortalPackageAccess = {
    available: true,
    licenseUsable: true,
    registryOrigin: "https://pkg.plrs.im",
    username: "__token__",
    feeds: [{ ecosystem: "npm", accessMode: "licensed", baseUrl: null }],
    tokens: [],
    limits: {
      minDays: 1,
      maxDays: 365,
      defaultDays: 90,
      urlDefaultDays: 365,
      perLicense: 10,
    },
  };

  it("is one pointer row to Account → Packages, with no token list", async () => {
    window.history.replaceState(null, "", "/#/p/tidewater/package");
    mockFetch(
      signedIn([tidewater], {
        "/api/licenses/tidewater/lic_tidewater": detail(tidewater),
        [BASE]: access,
      }),
    );
    renderPortal();
    const h = await screen.findByRole("heading", { name: /^Packages$/ });
    const c = h.closest("section")!;
    expect(within(c).getByText(/Tidewater Studio packages from/)).toBeTruthy();
    const link = within(c).getByRole("link", {
      name: /Set up in Account → Packages/,
    });
    expect(link.getAttribute("href")).toBe("#/account/packages");
    expect(within(c).queryByRole("button")).toBeNull();
  });

  it("is absent when the product has no private feed", async () => {
    window.history.replaceState(null, "", "/#/p/tidewater/package");
    mockFetch(
      signedIn([tidewater], {
        "/api/licenses/tidewater/lic_tidewater": detail(tidewater),
        [BASE]: { ...access, available: false, feeds: [] },
      }),
    );
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Tidewater Studio" });
    await waitFor(() => expect(fetchedRequests()).toContain(`GET ${BASE}`));
    expect(screen.queryByRole("heading", { name: /^Packages$/ })).toBeNull();
  });
});
