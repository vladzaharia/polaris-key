import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../src/App.js";
import { resetCache } from "../src/context.js";
import { setLoginRedirectForTests } from "../src/api.js";

// A scripted fetch: maps a path -> JSON body. Mutations echo `ok`.
function mockFetch(routes: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace("http://localhost", "");
      const body = routes[path] ?? routes[Object.keys(routes).find((k) => path.startsWith(k)) ?? ""] ?? {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

const ME = {
  sub: "u1",
  name: "Ada Lovelace",
  email: "ada@x.io",
  csrf: "csrf-token",
  platformAdmin: true,
  products: [
    { slug: "djdl", name: "DJDL", schemaVersion: 1 },
    { slug: "acme", name: "Acme", schemaVersion: 1 },
  ],
};

beforeEach(() => {
  window.location.hash = "";
  resetCache();
  setLoginRedirectForTests(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("admin SPA", () => {
  it("renders the shell with the signed-in operator", async () => {
    mockFetch({
      "/admin/api/me": ME,
      "/admin/api/products/djdl/licenses": { licenses: [] },
    });
    render(<App />);
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    // The product switcher offers both administered products.
    const select = (await screen.findByLabelText("Product")) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["djdl", "acme"]);
  });

  it("switches products via the switcher", async () => {
    mockFetch({
      "/admin/api/me": ME,
      "/admin/api/products/djdl/licenses": { licenses: [] },
      "/admin/api/products/acme/licenses": { licenses: [{ id: "lic_a", name: "Bob", email: "b@x.io", status: "active", enrolledAt: 0, expiresAt: null, keyCount: 1, activeKeyCount: 1, machineCount: 0, profile: null, tier: null, identityProvider: "manual" }] },
    });
    render(<App />);
    const select = (await screen.findByLabelText("Product")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "acme" } });
    // Navigating to acme loads its licenses (Bob appears).
    expect(await screen.findByText("Bob")).toBeTruthy();
    expect(window.location.hash).toContain("/p/acme/");
  });

  it("shows the platform Products view for platform admins", async () => {
    mockFetch({
      "/admin/api/me": ME,
      "/admin/api/products": { products: [{ slug: "djdl", name: "DJDL", signingKid: "k", compatMin: "0", compatMax: "9", defaultMaxOfflineDays: 30, defaultMachineLimit: 5, adminGroup: null, createdAt: 0, modifiedAt: 0 }] },
    });
    window.location.hash = "#/products";
    render(<App />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Products" })).toBeTruthy());
    expect(screen.getByText("New product")).toBeTruthy();
  });
});
