import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App.js";
import { resetCache } from "../src/context.js";
import { setLoginRedirectForTests } from "../src/api.js";

// A scripted fetch: maps a path -> JSON body. These are SMOKE tests for the app shell — we
// assert navigation + chrome (the views' own behavior is covered by their dedicated suites).
function mockFetch(routes: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const path = url.replace("http://localhost", "").split("?")[0]!;
      const body =
        routes[path] ??
        routes[Object.keys(routes).find((k) => path.startsWith(k)) ?? ""] ??
        {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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
  // jsdom lacks these Radix-needed APIs.
  (
    Element.prototype as unknown as { hasPointerCapture: () => boolean }
  ).hasPointerCapture = () => false;
  (
    Element.prototype as unknown as { scrollIntoView: () => void }
  ).scrollIntoView = () => undefined;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("admin SPA shell", () => {
  it("boots, shows the brand, and lands on the dashboard", async () => {
    mockFetch({ "/admin/api/me": ME });
    render(<App />);
    // The dashboard greets the signed-in operator.
    expect(await screen.findByText(/Welcome, Ada/)).toBeTruthy();
    // The brand lockup is present (sidebar logo, label "Polaris Key").
    expect(screen.getAllByLabelText("Polaris Key").length).toBeGreaterThan(0);
  });

  it("exposes the account menu with the operator identity", async () => {
    mockFetch({ "/admin/api/me": ME });
    render(<App />);
    await screen.findByText(/Welcome, Ada/);
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("ada@x.io")).toBeTruthy();
    expect(within(menu).getByText("Sign out")).toBeTruthy();
  });

  it("navigates to a per-product tab via the hash", async () => {
    mockFetch({
      "/admin/api/me": ME,
      "/admin/api/products/djdl": {
        product: {
          slug: "djdl",
          name: "DJDL",
          schemaVersion: 1,
          compatMin: "0.1.0",
          compatMax: "2.x",
          defaultDeviceLimit: 5,
          defaultMaxOfflineDays: 14,
          releaseSource: "github",
          signingKid: "pkey-djdl-prod",
          signing: {
            kid: "pkey-djdl-prod",
            alg: "Ed25519",
            publicKey: "pub_djdl",
            trustKeys: { "pkey-djdl-prod": "pub_djdl" },
          },
          modules: {
            licensing: { enabled: true, status: "configured" },
            config: { enabled: true, status: "configured" },
          },
          setup: { status: "ok", healthy: true, nextActions: [] },
        },
      },
    });
    window.location.hash = "#/p/djdl/overview";
    render(<App />);
    // The shell title + the view header both name the tab, so assert at least one heading.
    expect(
      (await screen.findAllByRole("heading", { name: "Overview" })).length,
    ).toBeGreaterThan(0);
    expect(await screen.findByText("SDK trust key")).toBeTruthy();
  });

  it("shows the platform Products view for platform admins", async () => {
    mockFetch({ "/admin/api/me": ME });
    window.location.hash = "#/products";
    render(<App />);
    expect(
      (await screen.findAllByRole("heading", { name: "Products" })).length,
    ).toBeGreaterThan(0);
  });

  it("blocks a product the operator does not administer", async () => {
    mockFetch({ "/admin/api/me": { ...ME, platformAdmin: false } });
    window.location.hash = "#/p/nope/licenses";
    render(<App />);
    expect(await screen.findByText("Not authorized")).toBeTruthy();
  });
});
