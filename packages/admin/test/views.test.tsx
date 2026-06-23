import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { setCsrf } from "../src/api.js";
import { AdminProvider, StatusProvider, resetCache } from "../src/context.js";
import type { Me } from "../src/api.js";
import { Licenses } from "../src/views/Licenses.js";
import { LicenseDetailView } from "../src/views/LicenseDetail.js";
import { Tiers } from "../src/views/Tiers.js";
import { Activity } from "../src/views/Activity.js";
import { SchemaCatalog } from "../src/views/SchemaCatalog.js";

// A scripted fetch that maps a request path (longest-prefix) + method to a JSON body. Records
// every request so we can assert the mutations a view fires. Network-free.
interface Route {
  body: unknown;
  status?: number;
}
let requests: { url: string; method: string; body?: unknown }[] = [];
function mockApi(routes: Record<string, Route | unknown>): void {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace("http://localhost", "");
      const method = init.method ?? "GET";
      requests.push({ url: path, method, body: init.body ? JSON.parse(init.body as string) : undefined });
      const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
      const matchKey = keys.find((k) => path === k || path.startsWith(k));
      const route = (matchKey ? routes[matchKey] : {}) as Route | unknown;
      const r = (route && typeof route === "object" && "body" in route ? route : { body: route }) as Route;
      return new Response(JSON.stringify(r.body ?? {}), {
        status: r.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

const ME: Me = {
  sub: "u1",
  name: "Ada",
  email: "ada@x.io",
  csrf: "csrf",
  platformAdmin: true,
  products: [{ slug: "djdl", name: "DJDL", schemaVersion: 1 }],
};

/** Render a view inside the admin + status providers, scoped to product "djdl". */
function renderView(node: ReactElement) {
  return render(
    <AdminProvider value={{ me: ME, product: "djdl", setProduct: () => undefined }}>
      <StatusProvider>{node}</StatusProvider>
    </AdminProvider>,
  );
}

beforeEach(() => {
  resetCache();
  setCsrf("csrf");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LICENSE = {
  id: "lic_1",
  name: "Bob Jones",
  email: "bob@x.io",
  status: "active",
  enrolledAt: 0,
  expiresAt: null,
  keyCount: 2,
  activeKeyCount: 1,
  machineCount: 3,
  profile: null,
  tier: null,
  identityProvider: "manual",
};

describe("Licenses view", () => {
  it("renders the roster from mock api data", async () => {
    mockApi({ "/admin/api/products/djdl/licenses": { licenses: [LICENSE] } });
    renderView(<Licenses />);
    expect(await screen.findByText("Bob Jones")).toBeTruthy();
    expect(screen.getByText("bob@x.io")).toBeTruthy();
    // active key count / total.
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("creating a license POSTs and surfaces the minted key once", async () => {
    mockApi({
      "/admin/api/products/djdl/licenses": { licenses: [] },
    });
    // The POST returns a minted key — override the responder for the mutation.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input).replace("http://localhost", "");
        if ((init.method ?? "GET") === "POST" && url.endsWith("/licenses")) {
          return new Response(JSON.stringify({ licenseId: "l9", key: "PK-SECRET-KEY", license: LICENSE }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ licenses: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    renderView(<Licenses />);
    fireEvent.change(await screen.findByLabelText("License name"), { target: { value: "New User" } });
    fireEvent.change(screen.getByLabelText("License email"), { target: { value: "n@x.io" } });
    fireEvent.click(screen.getByRole("button", { name: "Create license" }));
    expect(await screen.findByText("PK-SECRET-KEY")).toBeTruthy();
  });

  it("surfaces a load error", async () => {
    mockApi({ "/admin/api/products/djdl/licenses": { body: { message: "nope" }, status: 500 } });
    renderView(<Licenses />);
    await waitFor(() => expect(screen.getByText(/nope|api 500/)).toBeTruthy());
  });
});

describe("LicenseDetail view", () => {
  const DETAIL = {
    ...LICENSE,
    overrides: { config: {}, secrets: {}, entitlements: {} },
    keys: [{ hash: "abcdef0123456789", status: "active", createdAt: 0, createdBy: "u1" }],
    machines: [{ machineId: "m1", status: "authorized", firstSeen: 0, lastSeen: 0 }],
  };
  const CATALOG = {
    schemaVersion: 1,
    entries: [{ key: "theme.mode", kind: "config", category: "ui", label: "Theme", description: "", schema: { type: "string", enum: ["dark", "light"] } }],
  };

  it("renders keys, devices, and the override editor from mock data", async () => {
    mockApi({
      "/admin/api/products/djdl/licenses/lic_1": DETAIL,
      "/admin/api/products/djdl/schema": CATALOG,
    });
    renderView(<LicenseDetailView id="lic_1" />);
    expect(await screen.findByRole("heading", { name: "Bob Jones" })).toBeTruthy();
    // Truncated key hash + machine id.
    expect(screen.getByText(/abcdef012345/)).toBeTruthy();
    expect(screen.getByText("m1")).toBeTruthy();
    // The catalog drives the override editor field.
    expect(await screen.findByLabelText("Theme")).toBeTruthy();
  });

  it("toggling a license disable/enable POSTs the right endpoint", async () => {
    mockApi({
      "/admin/api/products/djdl/licenses/lic_1": DETAIL,
      "/admin/api/products/djdl/schema": CATALOG,
    });
    renderView(<LicenseDetailView id="lic_1" />);
    const disableBtn = await screen.findByRole("button", { name: "Disable" });
    fireEvent.click(disableBtn);
    await waitFor(() => expect(requests.some((r) => r.method === "POST" && r.url.endsWith("/disable"))).toBe(true));
  });

  it("renders an error when the license fails to load", async () => {
    mockApi({ "/admin/api/products/djdl/licenses/lic_1": { body: { message: "gone" }, status: 404 } });
    renderView(<LicenseDetailView id="lic_1" />);
    await waitFor(() => expect(screen.getByText(/gone|api 404/)).toBeTruthy());
  });
});

describe("Tiers view", () => {
  it("renders tiers from mock data", async () => {
    mockApi({
      "/admin/api/products/djdl/tiers": {
        tiers: [{ id: "pro", label: "Pro", profile: "p1", policyExpiryDays: 30, policyMachineLimit: 5 }],
      },
    });
    renderView(<Tiers />);
    expect(await screen.findByText("Pro")).toBeTruthy();
    expect(screen.getByText("p1")).toBeTruthy();
  });

  it("creating a tier POSTs and announces success", async () => {
    mockApi({ "/admin/api/products/djdl/tiers": { tiers: [] } });
    renderView(<Tiers />);
    fireEvent.change(await screen.findByLabelText("Tier id"), { target: { value: "starter" } });
    fireEvent.click(screen.getByRole("button", { name: "Create tier" }));
    await waitFor(() => expect(requests.some((r) => r.method === "POST" && r.url.endsWith("/tiers"))).toBe(true));
  });
});

describe("Activity view", () => {
  it("renders activity items from mock data", async () => {
    mockApi({
      "/admin/api/products/djdl/activity": {
        items: [{ id: "a1", at: 1700000000, actor: { sub: "u1", name: "Ada", email: "a@x.io" }, action: "license.create", target: null, summary: "Created a license" }],
        nextCursor: null,
      },
    });
    renderView(<Activity />);
    expect(await screen.findByText("license.create")).toBeTruthy();
    expect(screen.getByText("Created a license")).toBeTruthy();
  });

  it("shows the empty state when there is no activity", async () => {
    mockApi({ "/admin/api/products/djdl/activity": { items: [], nextCursor: null } });
    renderView(<Activity />);
    expect(await screen.findByText("No activity yet.")).toBeTruthy();
  });
});

describe("SchemaCatalog view", () => {
  const CATALOG = {
    schemaVersion: 3,
    entries: [{ key: "run.concurrency", kind: "config", category: "run", label: "Concurrency", description: "", schema: { type: "integer" } }],
  };

  it("lists active entries + the version", async () => {
    mockApi({ "/admin/api/products/djdl/schema": CATALOG });
    renderView(<SchemaCatalog />);
    expect(await screen.findByText("run.concurrency")).toBeTruthy();
    expect(screen.getByText(/Active version: 3/)).toBeTruthy();
  });

  it("a valid key + schema fragment shows a live preview", async () => {
    mockApi({ "/admin/api/products/djdl/schema": CATALOG });
    renderView(<SchemaCatalog />);
    await screen.findByText("run.concurrency");
    fireEvent.change(screen.getByLabelText("Entry key"), { target: { value: "new.flag" } });
    // The default schema fragment is { type: "string" } → preview renders a labelled input.
    const preview = await screen.findByText("Live preview");
    expect(preview).toBeTruthy();
    // The preview renders a SchemaField for the draft (label defaults to the key).
    expect(within(preview.parentElement as HTMLElement).getByLabelText("new.flag")).toBeTruthy();
  });

  it("an invalid JSON-Schema fragment surfaces a parse error and disables publish", async () => {
    mockApi({ "/admin/api/products/djdl/schema": CATALOG });
    renderView(<SchemaCatalog />);
    await screen.findByText("run.concurrency");
    fireEvent.change(screen.getByLabelText("Entry key"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("JSON Schema fragment"), { target: { value: "{ not json" } });
    expect(await screen.findByText(/Schema JSON:/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Publish new version" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("publishing PUTs a bumped catalog version", async () => {
    mockApi({ "/admin/api/products/djdl/schema": CATALOG });
    renderView(<SchemaCatalog />);
    await screen.findByText("run.concurrency");
    fireEvent.change(screen.getByLabelText("Entry key"), { target: { value: "new.key" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish new version" }));
    await waitFor(() => {
      const put = requests.find((r) => r.method === "PUT" && r.url.endsWith("/schema"));
      expect(put).toBeTruthy();
      expect((put!.body as { catalog: { schemaVersion: number } }).catalog.schemaVersion).toBe(4);
    });
  });
});
