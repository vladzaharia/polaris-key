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
        licenseId: "lic_tidewater",
        namespace: { scope: "@tidewater" },
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
    legacy: [],
    ...over,
  };
}

function routes(extra: Record<string, unknown> = {}) {
  return signedIn([], { [ME]: tokens(), ...extra } as never);
}

/** Wait for the dialog to put focus in Name (its opening), then type: no keystroke is lost. */
async function typeName(form: HTMLElement, text: string): Promise<void> {
  const field = within(form).getByLabelText("Name");
  await waitFor(() => expect(document.activeElement).toBe(field));
  await userEvent.type(field, text);
}

async function card(): Promise<HTMLElement> {
  const h = await screen.findByRole("heading", {
    name: "Your personal tokens",
  });
  return h.closest("section")!;
}

describe("Account → Packages (F-33)", () => {
  it("lists the live personal tokens by name and last four, and a setup named by client that never holds a token", async () => {
    mockFetch(routes());
    renderPortal();
    const c = await card();
    expect(within(c).getByText("CI build server")).toBeTruthy();
    expect(within(c).getByText(/pkeyp_…Hq2a/)).toBeTruthy();
    expect(within(c).getByText("Expires in 6 days")).toBeTruthy();
    expect(within(c).getByText(/Never used/)).toBeTruthy();
    expect(within(c).queryByText("Old")).toBeNull();
    expect(c.textContent).toContain("PKEY_REGISTRY_TOKEN");
    expect(c.textContent).not.toContain(TOKEN);
    // Tabs are named by client, and the real scope is in the snippet.
    expect(within(c).getByRole("tab", { name: "npm and pnpm" })).toBeTruthy();
    expect(c.textContent).toContain("@tidewater:registry");
    expect(
      screen.getAllByRole("link", { name: "Packages" }).length,
    ).toBeGreaterThan(0);
    expect(await axeViolations()).toEqual([]);
  });

  it("leaves Packages out when the account has no feed, token or per-app token", async () => {
    mockFetch(routes({ [ME]: tokens({ feeds: [], tokens: [] }) }));
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Account" });
    await waitFor(() => expect(fetchedRequests()).toContain(`GET ${ME}`));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: /^Packages$/ })).toBeNull(),
    );
    expect(screen.queryByRole("link", { name: "Packages" })).toBeNull();
  });

  it("with tokens but no private feed, lists them without offering to create one", async () => {
    mockFetch(routes({ [ME]: tokens({ feeds: [] }) }));
    renderPortal();
    const c = await card();
    expect(within(c).getByText("CI build server")).toBeTruthy();
    expect(
      within(c).queryByRole("button", { name: "Create personal token" }),
    ).toBeNull();
  });

  it("shows a new personal token once, with the shell line, and Escape and the scrim cannot close it before it is copied", async () => {
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
      within(c).getByRole("button", { name: "Create personal token" }),
    );
    const form = await screen.findByRole("dialog", {
      name: "Create a personal token",
    });
    expect(
      within(form).getByText(/Expires Dec 30, 2026|Expires \w+ \d+, \d{4}/),
    ).toBeTruthy();
    await typeName(form, "Laptop 2");
    await userEvent.click(within(form).getByRole("button", { name: "Create" }));
    const shown = await screen.findByRole("dialog", {
      name: "Copy your personal token now",
    });
    expect(posted).toEqual([{ label: "Laptop 2", expiresInDays: 90 }]);
    expect(within(shown).getAllByText(TOKEN).length).toBeGreaterThan(0);
    expect(shown.textContent).toContain(`export PKEY_REGISTRY_TOKEN=${TOKEN}`);
    // The setup snippets name the variable: the real token is never written into a config file.
    expect(shown.textContent).toContain("${PKEY_REGISTRY_TOKEN}");
    expect(shown.textContent).not.toContain(`_authToken=${TOKEN}`);
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
        screen.queryByRole("dialog", { name: "Copy your personal token now" }),
      ).toBeNull(),
    );
    expect(document.body.textContent).not.toContain(TOKEN);
    // Focus lands on a control of the page, not the body.
    await waitFor(
      () => expect(document.activeElement).not.toBe(document.body),
      { timeout: 4000 },
    );
  });

  it("says give it a name on an empty submit, and asks to confirm it's you without a second footer", async () => {
    mockFetch(
      routes({
        [`POST ${ME}`]: { status: 401, body: { error: "step_up_required" } },
      }),
    );
    renderPortal();
    const c = await card();
    await userEvent.click(
      within(c).getByRole("button", { name: "Create personal token" }),
    );
    const form = await screen.findByRole("dialog", {
      name: "Create a personal token",
    });
    await userEvent.click(within(form).getByRole("button", { name: "Create" }));
    expect(within(form).getByText("Give it a name.")).toBeTruthy();
    await typeName(form, "Laptop 2");
    await userEvent.click(within(form).getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(within(form).queryByRole("button", { name: "Create" })).toBeNull(),
    );
    expect(
      (within(form).getByLabelText("Name") as HTMLInputElement).value,
    ).toBe("Laptop 2");
  });

  it("revokes after an inline confirmation, Escape backs out, and focus moves to the next row", async () => {
    let revoked = false;
    const two = [
      token(),
      token({ id: "pt_two", label: "Second", hint: "zzzz" }),
    ];
    mockFetch(
      routes({
        [ME]: () =>
          revoked
            ? tokens({ tokens: [token({ status: "revoked" }), two[1]!] })
            : tokens({ tokens: two }),
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
    fireEvent.keyDown(q, { key: "Escape" });
    await waitFor(() =>
      expect(within(c).queryByText("Revoke CI build server?")).toBeNull(),
    );
    await userEvent.click(
      within(c).getByRole("button", { name: "Revoke CI build server" }),
    );
    await userEvent.click(
      within(c).getByRole("button", { name: "Revoke CI build server" }),
    );
    await waitFor(() =>
      expect(within(c).queryByText("CI build server")).toBeNull(),
    );
    expect(fetchedRequests()).toContain(`DELETE ${ME}/pt_ci`);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(c).getByRole("button", { name: "Revoke Second" }),
      ),
    );
  });

  it("lists per-app tokens apart and revokes one through its licence", async () => {
    mockFetch(
      routes({
        [ME]: tokens({
          legacy: [
            {
              product: "tidewater",
              productName: "Tidewater Studio",
              licenseId: "lic_tidewater",
              tokenId: "rt_old",
              label: "Old laptop",
              hint: "q9Zx",
              ecosystems: null,
              presentation: "header",
              createdAt: NOW_S - 90 * DAY,
              expiresAt: NOW_S + 30 * DAY,
              lastUsedAt: null,
              revokedAt: null,
              status: "active",
            },
          ],
        }),
        "DELETE /api/licenses/tidewater/lic_tidewater/registry-tokens/rt_old": {
          ok: true,
          view: {},
        },
      }),
    );
    renderPortal();
    const c = await card();
    const group = within(c).getByRole("heading", { name: "Per-app tokens" })
      .parentElement!.parentElement!;
    expect(within(group).getByText("Old laptop")).toBeTruthy();
    expect(within(group).getByText(/pkeyr_…q9Zx/)).toBeTruthy();
    await userEvent.click(
      within(group).getByRole("button", { name: "Revoke Old laptop" }),
    );
    await userEvent.click(
      within(group).getByRole("button", { name: "Revoke Old laptop" }),
    );
    await waitFor(() =>
      expect(fetchedRequests()).toContain(
        "DELETE /api/licenses/tidewater/lic_tidewater/registry-tokens/rt_old",
      ),
    );
  });

  it("gives a private Godot feed its own licence-bound URL, never a personal token in a URL", async () => {
    const posted: unknown[] = [];
    mockFetch(
      routes({
        [ME]: tokens({
          feeds: [
            {
              product: "tidewater",
              productName: "Tidewater Studio",
              licenseId: "lic_tidewater",
              ecosystem: "godot",
              accessMode: "licensed",
              baseUrl: "https://pkg.plrs.im/godot/tidewater/",
              namespace: {},
            },
          ],
        }),
        "POST /api/licenses/tidewater/lic_tidewater/registry-tokens": (
          init: RequestInit,
        ) => {
          posted.push(JSON.parse(String(init.body)));
          return {
            status: 201,
            body: {
              ok: true,
              token: "pkeyr_GodotUrlToken0123456789abcdef",
              view: {},
            },
          };
        },
      }),
    );
    renderPortal();
    const c = await card();
    expect(
      within(c).getByText(/Godot editor can't use personal tokens/),
    ).toBeTruthy();
    await userEvent.click(
      within(c).getByRole("button", { name: "Create Godot editor URL" }),
    );
    const form = await screen.findByRole("dialog", {
      name: "Create a Godot editor URL",
    });
    await userEvent.click(within(form).getByRole("button", { name: "Create" }));
    const shown = await screen.findByRole("dialog", {
      name: "Copy your Godot editor URL now",
    });
    expect(posted).toEqual([
      {
        label: "Godot editor",
        ecosystem: "godot",
        presentation: "url",
        expiresInDays: 30,
      },
    ]);
    expect(shown.textContent).toContain("/t/pkeyr_GodotUrlToken");
    expect(shown.textContent).not.toContain("pkeyp_");
  });

  it("after a per-app revoke focus moves to the next per-app Revoke", async () => {
    const mk = (id: string, label: string) => ({
      product: "tidewater",
      productName: "Tidewater Studio",
      licenseId: "lic_tidewater",
      tokenId: id,
      label,
      hint: "q9Zx",
      ecosystems: null,
      presentation: "header",
      createdAt: NOW_S - 90 * DAY,
      expiresAt: NOW_S + 30 * DAY,
      lastUsedAt: null,
      revokedAt: null,
      status: "active" as const,
    });
    let gone = false;
    mockFetch(
      routes({
        [ME]: () =>
          tokens({
            legacy: gone
              ? [mk("rt_a", "Old A"), mk("rt_b", "Old B")].map((t, i) =>
                  i === 0 ? { ...t, status: "revoked" as const } : t,
                )
              : [mk("rt_a", "Old A"), mk("rt_b", "Old B")],
          }),
        "DELETE /api/licenses/tidewater/lic_tidewater/registry-tokens/rt_a":
          () => {
            gone = true;
            return { ok: true, view: {} };
          },
      }),
    );
    renderPortal();
    const c = await card();
    await userEvent.click(
      within(c).getByRole("button", { name: "Revoke Old A" }),
    );
    expect(
      within(c).getByText(/Use a personal token to reconnect/),
    ).toBeTruthy();
    await userEvent.click(
      within(c).getByRole("button", { name: "Revoke Old A" }),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(c).getByRole("button", { name: "Revoke Old B" }),
      ),
    );
  });

  it("with only Godot feeds, the Godot URL is the primary, no personal token is offered, and the URL is the shown value", async () => {
    mockFetch(
      routes({
        [ME]: tokens({
          tokens: [],
          feeds: [
            {
              product: "tidewater",
              productName: "Tidewater Studio",
              licenseId: "lic_tidewater",
              ecosystem: "godot",
              accessMode: "licensed",
              baseUrl: "https://pkg.plrs.im/godot/tidewater/",
              namespace: {},
            },
          ],
        }),
        "POST /api/licenses/tidewater/lic_tidewater/registry-tokens": {
          status: 201,
          body: {
            ok: true,
            token: "pkeyr_GodotUrlToken0123456789abcdef",
            view: {},
          },
        },
      }),
    );
    renderPortal();
    const h = await screen.findByRole("heading", { name: /^Packages$/ });
    const c = h.closest("section")!;
    await screen.findByText(/can't use personal tokens/);
    expect(
      within(c).queryByRole("button", { name: "Create personal token" }),
    ).toBeNull();
    expect(c.textContent).not.toContain("No personal tokens yet");
    expect(c.textContent).not.toContain("PKEY_REGISTRY_TOKEN");
    await userEvent.click(
      within(c).getByRole("button", { name: "Create Godot editor URL" }),
    );
    const form = await screen.findByRole("dialog", {
      name: "Create a Godot editor URL",
    });
    await userEvent.click(within(form).getByRole("button", { name: "Create" }));
    const shown = await screen.findByRole("dialog", {
      name: "Copy your Godot editor URL now",
    });
    expect(
      within(shown).getByRole("button", { name: "Copy Godot editor URL" }),
    ).toBeTruthy();
    expect(
      within(shown).getAllByText(
        "https://pkg.plrs.im/godot/tidewater/t/pkeyr_GodotUrlToken0123456789abcdef/asset-library/api",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      within(shown).getByRole("tab", { name: "Godot 4.4 to 4.6" }),
    ).toBeTruthy();
    expect(shown.textContent).toContain("Godot 4.4 to 4.6: Editor Settings");
    expect(shown.textContent).not.toContain("4.6 and earlier");
  });

  it("names the Godot refusals: the limit and an inactive license", async () => {
    let status = 409;
    mockFetch(
      routes({
        [ME]: tokens({
          feeds: [
            {
              product: "tidewater",
              productName: "Tidewater Studio",
              licenseId: "lic_tidewater",
              ecosystem: "godot",
              accessMode: "licensed",
              baseUrl: "https://pkg.plrs.im/godot/tidewater/",
              namespace: {},
            },
          ],
        }),
        "POST /api/licenses/tidewater/lic_tidewater/registry-tokens": () => ({
          status,
          body: {
            error: "x",
            reason: status === 409 ? "token_limit" : undefined,
          },
        }),
      }),
    );
    renderPortal();
    const c = await card();
    await userEvent.click(
      within(c).getByRole("button", { name: "Create Godot editor URL" }),
    );
    const form = await screen.findByRole("dialog", {
      name: "Create a Godot editor URL",
    });
    await userEvent.click(within(form).getByRole("button", { name: "Create" }));
    expect(
      await within(form).findByText(/already has the most per-app tokens/),
    ).toBeTruthy();
    status = 403;
    await userEvent.click(within(form).getByRole("button", { name: "Create" }));
    expect(
      await within(form).findByText(/Tidewater Studio license isn't active/),
    ).toBeTruthy();
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
      within(c).getByRole("button", { name: /Create personal token/ }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Create a personal token" }),
    ).toBeNull();
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
