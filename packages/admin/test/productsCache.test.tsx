import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toaster } from "../src/components/ui/index.js";
import { Products } from "../src/views/Products.js";
import {
  ALL_ON,
  ME,
  boot,
  mockFetch,
  productRow,
  resetConsole,
} from "./consoleHarness.js";

/**
 * Regression: the Products page showed no products, or the whole console went blank.
 *
 * `views/Products.tsx` cached the raw `{ products }` response under `qk.products()`, while the
 * shell's `useProducts` (which feeds the product switcher) cached the bare array under the same
 * key. Whichever fetched first decided the shape and broke the other reader: the page read
 * `array.products` (nothing), or the switcher called `.filter` on an object (a crash outside the
 * page's error boundary). Both now fetch through `fetchProducts()`; this drives the two readers
 * together, in both load orders, against a registry of one product. The static guard for every
 * key family is `queryKeyShapes.test.ts`.
 */

const ONE = [{ slug: "djdl", name: "DJDL", schemaVersion: 1 }];

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetConsole();
  consoleError = vi.spyOn(console, "error");
});
afterEach(() => {
  cleanup();
  consoleError.mockRestore();
  vi.unstubAllGlobals();
});

/** Open the switcher and return the product names it lists. */
async function switcherOptions(): Promise<string[]> {
  await userEvent.click(
    await screen.findByRole("button", { name: /^Product: DJDL \(djdl\)/ }),
  );
  const options = await screen.findAllByRole("option");
  const names = options.map((o) => o.textContent ?? "");
  await userEvent.keyboard("{Escape}");
  return names;
}

/** The console's own Products page (inside `main`) lists the one product. */
async function expectProductsPageRow(): Promise<void> {
  const main = await screen.findByRole("main");
  await waitFor(() => expect(within(main).getByText("djdl")).toBeTruthy());
  expect(within(main).getByText("DJDL")).toBeTruthy();
  expect(within(main).queryByText(/Something on this page broke/)).toBeNull();
}

function expectNoReactError(): void {
  expect(consoleError).not.toHaveBeenCalled();
  expect(screen.queryByText(/Something on this page broke/)).toBeNull();
}

describe("qk.products() holds one shape for the Products page and the switcher", () => {
  it("Products page first, then the shell's useProducts", async () => {
    // The Products page's fetcher fills the cache before the shell mounts.
    mockFetch({
      "/manage/api/products": {
        products: ONE.map((p) => productRow(p.slug, p.name, ALL_ON)),
      },
    });
    const standalone = render(
      <Toaster>
        <Products />
      </Toaster>,
    );
    await waitFor(() =>
      expect(within(standalone.container).getByText("djdl")).toBeTruthy(),
    );

    // Now the shell, whose switcher reads the same cache entry.
    boot("#/p/djdl", { services: ALL_ON, me: { ...ME, products: ONE } });
    await screen.findByRole("navigation", { name: "Console" });
    expect((await switcherOptions()).some((t) => t.startsWith("DJDL"))).toBe(
      true,
    );
    // The page that filled the cache still reads it.
    expect(within(standalone.container).getByText("djdl")).toBeTruthy();

    act(() => {
      window.location.hash = "#/products";
    });
    await expectProductsPageRow();
    expectNoReactError();
  });

  it("the shell's useProducts first, then the Products page", async () => {
    boot("#/p/djdl", { services: ALL_ON, me: { ...ME, products: ONE } });
    await screen.findByRole("navigation", { name: "Console" });
    expect((await switcherOptions()).some((t) => t.startsWith("DJDL"))).toBe(
      true,
    );

    act(() => {
      window.location.hash = "#/products";
    });
    await expectProductsPageRow();

    // And back on a product page the switcher still lists it from the shared entry.
    act(() => {
      window.location.hash = "#/p/djdl";
    });
    expect((await switcherOptions()).some((t) => t.startsWith("DJDL"))).toBe(
      true,
    );
    expectNoReactError();
  });
});
