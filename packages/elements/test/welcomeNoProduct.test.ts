// A Welcome with no product name anywhere is titled "Welcome", never "Welcome to" and nothing.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import "../src/index.js";
import type { PkElement } from "../src/index.js";
import type { UiInput } from "@polaris-key/ui-core";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => document.body.replaceChildren());

const NAMELESS: UiInput = {
  elapsedMs: 60_000,
  services: ["license", "sync", "identity"],
  platform: { os: "web", formFactor: "computer" },
  registration: "requires-license",
  capabilities: { signIn: true, keyEntry: true, deviceCode: true },
};

async function draw(input: UiInput): Promise<PkElement> {
  const el = document.createElement("pk-welcome") as PkElement;
  el.input = input;
  document.body.replaceChildren(el);
  await el.updateComplete;
  return el;
}
const title = (el: PkElement) =>
  el.shadowRoot!.querySelector('[data-part="title"]');

describe("a Welcome with no product name", () => {
  it("is titled Welcome", async () => {
    const el = await draw(NAMELESS);
    expect(title(el)?.textContent?.trim()).toBe("Welcome");
    expect(title(el)?.getAttribute("data-key")).toBe(
      "common.welcomeNoProductTitle",
    );
  });

  it("keeps the product's title when there is a name", async () => {
    const el = await draw({
      ...NAMELESS,
      bundle: { slug: "tidewater", name: "Tidewater Studio" },
    });
    expect(title(el)?.textContent?.trim()).toBe("Welcome to Tidewater Studio");
  });

  it("asks a sign-in-only product to sign in without naming it", async () => {
    const el = await draw({
      ...NAMELESS,
      capabilities: { signIn: true, keyEntry: false, deviceCode: true },
    });
    expect(el.shadowRoot!.textContent).toContain("Sign in to continue.");
    expect(el.shadowRoot!.textContent).not.toMatch(/Sign in to use\s*\./);
  });
});
