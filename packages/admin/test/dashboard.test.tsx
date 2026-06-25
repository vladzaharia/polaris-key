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
    expect(open.getAttribute("href")).toBe("#/p/acme/overview");
  });

  it("shows an empty state when the operator administers no products", () => {
    render(withAdmin(makeMe({ products: [] })));
    expect(screen.getByText("No products yet")).toBeTruthy();
    // No product cards.
    expect(screen.queryAllByRole("listitem").length).toBe(0);
  });

  it("labels a non-platform operator as a product administrator", () => {
    render(withAdmin(makeMe({ platformAdmin: false })));
    expect(screen.getByText(/Product administrator/)).toBeTruthy();
    // No platform-only registry link.
    expect(screen.queryByRole("link", { name: "Manage registry" })).toBeNull();
  });
});
