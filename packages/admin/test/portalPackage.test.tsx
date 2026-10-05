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
  PortalRegistryToken,
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
const TOKEN = "pkeyr_Lm9xT2qVb8sPzK4wNc7dRf1hYj3e";

beforeEach(() => {
  window.history.replaceState(null, "", "/#/p/tidewater/package");
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_UA);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const tidewater = license({
  product: "tidewater",
  productName: "Tidewater Studio",
  tier: "pro",
});
const BASE = "/api/licenses/tidewater/lic_tidewater/registry-tokens";

function token(over: Partial<PortalRegistryToken> = {}): PortalRegistryToken {
  return {
    tokenId: "rt_ci",
    label: "CI build server",
    hint: "Hq2a",
    scopes: ["read"],
    ecosystems: null,
    presentation: "header",
    createdAt: NOW_S - 60 * DAY,
    expiresAt: NOW_S + 90 * DAY,
    lastUsedAt: NOW_S - 3 * 3600,
    revokedAt: null,
    status: "active",
    ...over,
  };
}

function access(over: Partial<PortalPackageAccess> = {}): PortalPackageAccess {
  return {
    available: true,
    licenseUsable: true,
    registryOrigin: "https://pkg.plrs.im",
    username: "__token__",
    feeds: [
      {
        ecosystem: "npm",
        accessMode: "licensed",
        baseUrl: "https://pkg.plrs.im/npm/tidewater/",
      },
    ],
    tokens: [
      token(),
      token({
        tokenId: "rt_laptop",
        label: "Laptop",
        hint: "j3eX",
        lastUsedAt: null,
        expiresAt: NOW_S + 6 * DAY - 60,
      }),
      token({ tokenId: "rt_old", label: "Old", status: "revoked" }),
    ],
    limits: {
      minDays: 1,
      maxDays: 365,
      defaultDays: 90,
      urlDefaultDays: 365,
      perLicense: 10,
    },
    ...over,
  };
}

function routes(extra: Record<string, unknown> = {}) {
  return signedIn([tidewater], {
    "/api/licenses/tidewater/lic_tidewater": detail(tidewater),
    [BASE]: access(),
    ...extra,
  });
}

async function card(): Promise<HTMLElement> {
  const h = await screen.findByRole("heading", { name: /Package access/ });
  return h.closest("section")!;
}

describe("Package access (PX-11)", () => {
  it("lists the feed, this licence's live tokens and the setup, in the section nav", async () => {
    mockFetch(routes());
    renderPortal();
    const c = await card();
    expect(
      within(c).getByText(
        /Your Pro license includes the developer's private npm feed/,
      ),
    ).toBeTruthy();
    expect(
      within(c).getByText("https://pkg.plrs.im/npm/tidewater/"),
    ).toBeTruthy();
    expect(within(c).getByText("CI build server")).toBeTruthy();
    expect(within(c).getByText(/pkeyr_…Hq2a/)).toBeTruthy();
    expect(within(c).getByText("Expires in 6 days")).toBeTruthy();
    expect(within(c).getByText(/never used/)).toBeTruthy();
    // Revoked tokens are history, not listed.
    expect(within(c).queryByText("Old")).toBeNull();
    // The snippets name the token by its environment variable, never a value.
    expect(c.textContent).toContain("PKEY_REGISTRY_TOKEN");
    expect(c.textContent).not.toContain(TOKEN);
    expect(
      screen.getAllByRole("link", { name: /Package access/ }).length,
    ).toBeGreaterThan(0);
    expect(await axeViolations()).toEqual([]);
  });

  it("is absent when the product has no private feed, or the Worker has no such route", async () => {
    mockFetch(routes({ [BASE]: access({ available: false, feeds: [] }) }));
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Tidewater Studio" });
    await waitFor(() => expect(fetchedRequests()).toContain(`GET ${BASE}`));
    expect(
      screen.queryByRole("heading", { name: /Package access/ }),
    ).toBeNull();
    cleanup();
    mockFetch(
      routes({ [BASE]: { status: 404, body: { error: "not_found" } } }),
    );
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Tidewater Studio" });
    expect(
      screen.queryByRole("heading", { name: /Package access/ }),
    ).toBeNull();
  });

  it("shows a new token once, in a dialog Escape and the scrim cannot close before it is copied or acknowledged", async () => {
    const posted: unknown[] = [];
    mockFetch(
      routes({
        [`POST ${BASE}`]: (init: RequestInit) => {
          posted.push(JSON.parse(String(init.body)));
          return {
            status: 201,
            body: {
              ok: true,
              token: TOKEN,
              view: token({
                tokenId: "rt_new",
                label: "Laptop 2",
                hint: "j3e",
                lastUsedAt: null,
              }),
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
    expect(posted).toEqual([
      {
        label: "Laptop 2",
        ecosystem: "npm",
        presentation: "header",
        expiresInDays: 90,
      },
    ]);
    expect(within(shown).getAllByText(TOKEN).length).toBeGreaterThan(0);
    // The snippet carries the real token, in this dialog only.
    expect(shown.textContent).toContain(`_authToken=${TOKEN}`);
    expect(await axeViolations()).toEqual([]);

    // Escape does not close it: it asks instead.
    fireEvent.keyDown(shown, { key: "Escape" });
    expect(
      screen.getByRole("dialog", { name: "Copy your token now" }),
    ).toBeTruthy();
    expect(
      await within(shown).findByText(/Close without copying\?/),
    ).toBeTruthy();
    await userEvent.click(
      within(shown).getByRole("button", { name: "Keep it open" }),
    );
    // Nor does a click on the scrim: it asks again.
    const overlay = document.querySelector<HTMLElement>(".bg-black\\/60");
    expect(overlay).not.toBeNull();
    fireEvent.pointerDown(overlay!);
    expect(
      screen.getByRole("dialog", { name: "Copy your token now" }),
    ).toBeTruthy();
    expect(
      await within(shown).findByText(/Close without copying\?/),
    ).toBeTruthy();
    await userEvent.click(
      within(shown).getByRole("button", { name: "Keep it open" }),
    );
    // Done waits for the acknowledgement.
    const doneBtn = within(shown).getByRole("button", { name: "Done" });
    expect(
      doneBtn.getAttribute("aria-disabled") ??
        String((doneBtn as HTMLButtonElement).disabled),
    ).toMatch(/true/);
    await userEvent.click(
      within(shown).getByRole("checkbox", { name: /I've stored this token/ }),
    );
    await userEvent.click(within(shown).getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Copy your token now" }),
      ).toBeNull(),
    );
  });

  it("revokes a token after an inline confirmation", async () => {
    let revoked = false;
    mockFetch(
      routes({
        [BASE]: () =>
          revoked
            ? access({ tokens: [token({ status: "revoked" })] })
            : access({ tokens: [token()] }),
        [`DELETE ${BASE}/rt_ci`]: () => {
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
    expect(fetchedRequests()).toContain(`DELETE ${BASE}/rt_ci`);
  });

  it("an inactive licence can't make tokens, and says why", async () => {
    mockFetch(routes({ [BASE]: access({ licenseUsable: false }) }));
    renderPortal();
    const c = await card();
    expect(within(c).getByText(/This license isn't active/)).toBeTruthy();
    const btn = within(c).getByRole("button", { name: /Create token/ });
    await userEvent.click(btn);
    expect(screen.queryByRole("dialog", { name: "Create a token" })).toBeNull();
  });
});
