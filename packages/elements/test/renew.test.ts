// StatusScreen, expired: Renew is drawn only when the host can renew (input.renew).

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

const EXPIRED: UiInput = {
  elapsedMs: 60_000,
  gate: { status: "expired" },
  bundle: { slug: "tidewater", name: "Tidewater Studio" },
};

async function draw(input: UiInput): Promise<PkElement> {
  const el = document.createElement("pk-status-screen") as PkElement;
  el.input = input;
  document.body.replaceChildren(el);
  await el.updateComplete;
  return el;
}
const controls = (el: PkElement) =>
  [
    ...el.shadowRoot!.querySelectorAll<HTMLElement>(
      "[data-part=primary],[data-part=secondary]",
    ),
  ].map((e) => [e.dataset.key, e.dataset.part]);

describe("StatusScreen expired", () => {
  it("offers Use another license alone without a renewal", async () => {
    expect(controls(await draw(EXPIRED))).toEqual([
      ["status.useAnotherLicense", "primary"],
    ]);
  });

  it("draws Renew with the glyph for a url and reports it", async () => {
    const el = await draw({
      ...EXPIRED,
      renew: { url: "https://example.com/renew" },
    });
    expect(controls(el)).toEqual([
      ["status.renew", "primary"],
      ["status.useAnotherLicense", "secondary"],
    ]);
    const renew = el.shadowRoot!.querySelector<HTMLElement>(
      '[data-key="status.renew"]',
    )!;
    expect(renew.querySelector("svg")).not.toBeNull();
    let detail: Record<string, unknown> | undefined;
    el.addEventListener("pk-action", (e) => {
      detail = (e as CustomEvent).detail;
    });
    renew.click();
    expect(detail).toMatchObject({
      key: "status.renew",
      url: "https://example.com/renew",
    });
  });

  it("draws Renew without the glyph for a handler (renew: {})", async () => {
    const el = await draw({ ...EXPIRED, renew: {} });
    const renew = el.shadowRoot!.querySelector<HTMLElement>(
      '[data-key="status.renew"]',
    )!;
    expect(renew.querySelector("svg")).toBeNull();
  });
});
