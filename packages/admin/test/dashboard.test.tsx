import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { AdminProvider } from "../src/context.js";
import type { Me } from "../src/api.js";
import { Dashboard } from "../src/views/Dashboard.js";

function makeMe(over: Partial<Me> = {}): Me {
  return {
    sub: "u1",
    name: "Ada Lovelace",
    email: "ada@x.io",
    csrf: "c",
    platformAdmin: true,
    products: [
      { slug: "djdl", name: "DJDL", schemaVersion: 2 },
      { slug: "acme", name: "Acme", schemaVersion: 5 },
    ],
    ...over,
  };
}

function withAdmin(me: Me): ReactElement {
  return (
    <AdminProvider
      value={{
        me,
        product: me.products[0]?.slug ?? "",
        setProduct: () => undefined,
      }}
    >
      <Dashboard />
    </AdminProvider>
  );
}

afterEach(cleanup);

describe("Dashboard view", () => {
  it("greets the operator and lists their products as cards", () => {
    render(withAdmin(makeMe()));
    expect(screen.getByText(/Welcome, Ada/)).toBeTruthy();

    // One card per product, each with its name, slug, and schema version.
    const cards = screen.getAllByRole("listitem");
    expect(cards.length).toBe(2);

    const djdl = cards[0]!;
    expect(within(djdl).getByText("DJDL")).toBeTruthy();
    expect(within(djdl).getByText("djdl")).toBeTruthy();
    expect(within(djdl).getByText("schema v2")).toBeTruthy();

    // The "Products" stat reflects the count.
    expect(screen.getByText("Products")).toBeTruthy();
  });

  it("links each card into the product overview", () => {
    render(withAdmin(makeMe()));
    const open = screen.getByRole("link", { name: "Open Acme" });
    expect(open.getAttribute("href")).toBe("#/p/acme");
  });

  it("shows an empty state when the operator administers no products", () => {
    render(withAdmin(makeMe({ products: [] })));
    expect(screen.getByText("No products yet")).toBeTruthy();
    // No product cards.
    expect(screen.queryAllByRole("listitem").length).toBe(0);
  });

  // There is exactly one privilege level. `admin/auth.ts` gates session issuance on
  // `hasAnyAdminGrant`, which `admin/authz.ts` defines as the SAME predicate as
  // `isPlatformAdmin`, so `platformAdmin: false` is unreachable for any live session and
  // `handleMe` returns either every product or none. The previous version of this test
  // rendered `platformAdmin: false` and asserted a "Product administrator" label — i.e. it
  // was regression coverage FOR the per-product admin tier the control plane removed.
  it("states the single platform-wide privilege level, not a role hierarchy", () => {
    render(withAdmin(makeMe()));
    expect(screen.getByText(/Platform administrator/)).toBeTruthy();
    expect(screen.queryByText(/Product administrator/)).toBeNull();
    // No two-valued "Role" tile; access is unconditional and so is the registry link.
    expect(screen.queryByText("Role")).toBeNull();
    expect(screen.getByText("All products")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Manage registry" })).toBeTruthy();
  });

  it("never offers a per-product grant workflow in the empty state", () => {
    render(withAdmin(makeMe({ products: [] })));
    // No endpoint, table or UI exists by which a platform admin could "grant access" to one
    // product, so the empty state must not tell the operator to go and ask for one.
    expect(screen.queryByText(/grant access/i)).toBeNull();
    expect(screen.getByRole("link", { name: "Open registry" })).toBeTruthy();
  });
});
