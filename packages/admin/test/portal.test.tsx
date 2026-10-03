import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PortalApp } from "../src/portal/App.js";

type MockRoute =
  | unknown
  | {
      status: number;
      body?: unknown;
    };

function isMockResponse(
  route: MockRoute,
): route is { status: number; body?: unknown } {
  return (
    route != null &&
    typeof route === "object" &&
    "status" in route &&
    typeof route.status === "number"
  );
}

function mockFetch(routes: Record<string, MockRoute>): void {
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
      const route = routes[path];
      const status = isMockResponse(route) ? route.status : 200;
      const body = isMockResponse(route) ? route.body : route;
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

beforeEach(() => {
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("customer portal SPA", () => {
  it("renders only enabled sign-in methods from portal capabilities", async () => {
    mockFetch({
      "/api/me": { status: 401 },
      "/api/capabilities": {
        auth: { oidc: true, magic: false },
        modules: { licensing: true, claim: true, releases: true },
      },
    });

    render(<PortalApp />);

    const oidc = await screen.findByRole("link", {
      name: /continue with oidc/i,
    });
    expect(oidc.getAttribute("href")).toContain("/login?return_to=");
    expect(screen.queryByLabelText("Email")).toBeNull();
  });

  it("boots an authenticated dashboard and loads linked licenses", async () => {
    mockFetch({
      "/api/me": {
        account: { id: "acct_1", name: "Ada Lovelace", email: "ada@x.io" },
        csrf: "csrf-token",
      },
      "/api/capabilities": {
        auth: { oidc: true, magic: true },
        modules: { licensing: true, claim: true, releases: true },
      },
      "/api/licenses": {
        licenses: [
          {
            id: "lic_1",
            product: "djdl",
            productName: "DJDL",
            name: "Ada Lovelace",
            email: "ada@x.io",
            status: "active",
            tier: null,
            activatedAt: 1_700_000_000,
            expiresAt: null,
            maxOfflineDays: null,
            channels: [],
            minVersion: null,
            maxVersion: null,
            identityProvider: "manual",
            usable: true,
            keyCount: 1,
            activeKeyCount: 1,
            deviceCount: 2,
            entitlements: [],
          },
        ],
      },
    });

    render(<PortalApp />);

    expect(
      await screen.findByRole("heading", { name: "Licensing portal" }),
    ).toBeTruthy();
    expect(await screen.findByText("DJDL")).toBeTruthy();
    expect((await screen.findAllByText("2")).length).toBeGreaterThan(0);
  });

  it("labels each download with its platform and arch together", async () => {
    window.location.hash = "#/downloads";
    const artifact = (
      artifactId: string,
      name: string,
      platform: string | null,
      arch: string | null,
    ) => ({
      artifactId,
      name,
      kind: "archive",
      platform,
      arch,
      sizeBytes: 1024,
      sha256: null,
      access: "public",
      canDownload: true,
    });
    mockFetch({
      "/api/me": {
        account: { id: "acct_1", name: "Ada Lovelace", email: "ada@x.io" },
        csrf: "csrf-token",
      },
      "/api/capabilities": {
        auth: { oidc: true, magic: true },
        modules: { licensing: true, claim: true, releases: true },
      },
      "/api/licenses": { licenses: [] },
      "/api/releases": {
        releases: [
          {
            product: "djdl",
            productName: "DJDL",
            releaseId: "v1.2.3",
            version: "1.2.3",
            title: null,
            notes: null,
            publishedAt: 1_700_000_000,
            sourceUrl: null,
            artifacts: [
              artifact("1", "djdl-macos-arm64.app.zip", "macos", "arm64"),
              artifact("2", "djdl-windows-x64.zip", "windows", "x86_64"),
              artifact("3", "djdl-arm64", null, "arm64"),
              artifact("4", "NOTES.txt", null, null),
            ],
          },
        ],
      },
    });

    render(<PortalApp />);

    const mac = await screen.findByText("macOS Apple silicon");
    expect(mac.title).toBe("macOS · Apple silicon (arm64)");
    expect(screen.getByText("Windows x64").title).toBe(
      "Windows · x64 (x86_64)",
    );
    // No platform could be determined: still never a bare "arm64".
    expect(screen.getByText("Unknown platform ARM64")).toBeTruthy();
    expect(screen.queryByText(/(^|· )arm64( ·|$)/)).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Download djdl-macos-arm64.app.zip for macOS · Apple silicon (arm64)",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Download NOTES.txt" }),
    ).toBeTruthy();
  });

  it("hides disabled portal modules in the authenticated shell", async () => {
    mockFetch({
      "/api/me": {
        account: { id: "acct_1", name: "Ada Lovelace", email: "ada@x.io" },
        csrf: "csrf-token",
      },
      "/api/capabilities": {
        auth: { oidc: true, magic: true },
        modules: { licensing: true, claim: false, releases: false },
      },
      "/api/licenses": { licenses: [] },
    });

    render(<PortalApp />);

    expect(
      await screen.findByRole("heading", { name: "Licensing portal" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: /add a license/i }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: /downloads/i })).toBeNull();
  });
});
