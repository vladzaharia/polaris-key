// @pkey-feature ui.kit identity.link
//
// The link offer in the custom element (I-46.13): `<pk-sign-in>` with a `linkOffer` seed draws
// the offer; Link ends on Done or the conflict, No thanks is stored and closes the sheet, and a
// failed Link keeps the offer with its network line.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AutoOutcome, SignInPrimitives } from "@polaris-key/ui-core";

import "../src/index.js";
import type { PkSignIn } from "../src/index.js";
import { stubResizeObserver } from "./fixtures.js";

beforeAll(stubResizeObserver);
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

/** Lets the model's promises and Lit's updates run out. */
async function settle(el: PkSignIn): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await new Promise<void>((done) => setTimeout(done, 0));
    await el.updateComplete;
  }
}

const SEED: AutoOutcome = { kind: "linkOffer", input: { reach: "global" } };

function prims(
  accept: () => Promise<"linked" | "conflict" | "stale" | "failed">,
) {
  const decline = vi.fn(async () => undefined);
  const link = { accept: vi.fn(accept), decline };
  const primitives: SignInPrimitives = {
    start: async () => {
      throw new Error("not used");
    },
    link,
  };
  return { primitives, link };
}

async function draw(primitives: SignInPrimitives): Promise<PkSignIn> {
  const el = document.createElement("pk-sign-in") as PkSignIn;
  Object.assign(el, {
    presentation: "sheet",
    open: true,
    primitives,
    seed: SEED,
    input: { provider: "Google" },
  });
  document.body.replaceChildren(el);
  await settle(el);
  return el;
}

const keys = (el: Element): (string | null)[] =>
  Array.from(el.shadowRoot!.querySelectorAll("button[data-key]")).map((b) =>
    b.getAttribute("data-key"),
  );
const press = async (el: PkSignIn, key: string) => {
  el.shadowRoot!.querySelector<HTMLElement>(
    `button[data-key="${key}"]`,
  )!.click();
  await settle(el);
};

describe("the link offer", () => {
  it("offers Link and No thanks, and Link ends on Done then closes", async () => {
    const { primitives, link } = prims(async () => "linked");
    const el = await draw(primitives);
    expect(keys(el)).toEqual([
      "signin.linkOffer.primary",
      "signin.linkOffer.decline",
    ]);
    await press(el, "signin.linkOffer.primary");
    expect(link.accept).toHaveBeenCalledTimes(1);
    expect(keys(el)).toContain("common.continue");
    const closed = vi.fn();
    el.addEventListener("pk-close", closed);
    await press(el, "common.continue");
    expect(closed).toHaveBeenCalled();
    expect(el.open).toBe(false);
  });

  it("a conflict names Help and ends on Continue", async () => {
    const { primitives } = prims(async () => "conflict");
    const el = await draw(primitives);
    await press(el, "signin.linkOffer.primary");
    expect(keys(el)).toContain("signin.linkOffer.join");
    expect(keys(el)).toContain("common.continue");
  });

  it("No thanks is stored and closes the sheet", async () => {
    const { primitives, link } = prims(async () => "linked");
    const el = await draw(primitives);
    await press(el, "signin.linkOffer.decline");
    expect(link.decline).toHaveBeenCalledTimes(1);
    expect(link.accept).not.toHaveBeenCalled();
    expect(el.open).toBe(false);
  });

  it("a failed Link keeps the offer, says so, and Link tries again", async () => {
    const { primitives, link } = prims(async () => "failed");
    const el = await draw(primitives);
    await press(el, "signin.linkOffer.primary");
    expect(keys(el)).toContain("signin.linkOffer.primary");
    expect(
      el.shadowRoot!.querySelector('[data-key="core.codes.network.message"]'),
    ).not.toBeNull();
    await press(el, "signin.linkOffer.primary");
    expect(link.accept).toHaveBeenCalledTimes(2);
  });
});
