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
  accept: () => ReturnType<NonNullable<SignInPrimitives["link"]>["accept"]>,
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
  it("offers Link and No thanks, and Link closes the sheet with a toast", async () => {
    const { primitives, link } = prims(async () => "linked");
    const el = await draw(primitives);
    expect(keys(el)).toEqual([
      "signin.linkOffer.primary",
      "signin.linkOffer.decline",
    ]);
    await press(el, "signin.linkOffer.primary");
    expect(link.accept).toHaveBeenCalledTimes(1);
    expect(el.open).toBe(false);
    expect(
      el
        .shadowRoot!.querySelector('[data-part="toast"]')
        ?.getAttribute("data-key"),
    ).toBe("signin.linkOffer.done");
  });

  it("a conflict names Help and ends on Done", async () => {
    const { primitives } = prims(async () => "conflict");
    const el = await draw(primitives);
    await press(el, "signin.linkOffer.primary");
    expect(keys(el)).toContain("signin.linkOffer.join");
    expect(keys(el)).toContain("common.done");
  });

  it("No thanks is stored and closes the sheet", async () => {
    const { primitives, link } = prims(async () => "linked");
    const el = await draw(primitives);
    await press(el, "signin.linkOffer.decline");
    expect(link.decline).toHaveBeenCalledTimes(1);
    expect(link.accept).not.toHaveBeenCalled();
    expect(el.open).toBe(false);
  });

  it("a network failure keeps the offer, says so, and Link tries again", async () => {
    const { primitives, link } = prims(async () => "network");
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

describe("what a refused Link says", () => {
  const line = (el: PkSignIn, key: string) =>
    el.shadowRoot!.querySelector(`[data-key="${key}"]`);

  it("a stale sign-in says to sign in again, and the main button becomes Sign in again", async () => {
    const { primitives } = prims(async () => "stale");
    const el = await draw(primitives);
    await press(el, "signin.linkOffer.primary");
    expect(line(el, "signin.linkOffer.stale")).not.toBeNull();
    expect(keys(el)).toContain("signin.again");
    expect(keys(el)).not.toContain("signin.linkOffer.primary");
    expect(line(el, "core.codes.network.message")).toBeNull();
  });

  it("a refused device says so, is not the network's line, and Link is no longer offered", async () => {
    const { primitives } = prims(async () => "failed");
    const el = await draw(primitives);
    await press(el, "signin.linkOffer.primary");
    expect(line(el, "signin.linkOffer.failed")).not.toBeNull();
    expect(line(el, "core.codes.network.message")).toBeNull();
    expect(keys(el)).toEqual(["signin.linkOffer.decline"]);
  });

  it("every refusal line is announced as an alert", async () => {
    for (const r of ["stale", "failed", "network"] as const) {
      const { primitives } = prims(async () => r);
      const el = await draw(primitives);
      await press(el, "signin.linkOffer.primary");
      const key =
        r === "network"
          ? "core.codes.network.message"
          : `signin.linkOffer.${r}`;
      expect(line(el, key)?.closest('[role="alert"]'), r).not.toBeNull();
    }
  });

  it("No thanks cannot close the sheet while Link runs", async () => {
    let finish: (v: "linked") => void = () => {};
    const { primitives, link } = prims(
      () => new Promise<"linked">((resolve) => (finish = resolve)),
    );
    const el = await draw(primitives);
    await press(el, "signin.linkOffer.primary");
    const no = el.shadowRoot!.querySelector<HTMLElement>(
      '[data-key="signin.linkOffer.decline"]',
    )!;
    expect(no.getAttribute("aria-disabled")).toBe("true");
    await press(el, "signin.linkOffer.decline");
    expect(link.decline).not.toHaveBeenCalled();
    expect(el.open).toBe(true);
    finish("linked");
    await settle(el);
    expect(keys(el)).toContain("common.done");
  });

  it("nothing happened (the chooser was dismissed): the offer stays as it was", async () => {
    const { primitives } = prims(async () => "none");
    const el = await draw(primitives);
    await press(el, "signin.linkOffer.primary");
    expect(keys(el)).toContain("signin.linkOffer.primary");
    expect(
      el.shadowRoot!.querySelector('[role="alert"], [data-part="callout"]'),
    ).toBeNull();
  });
});

/** `<pk-gate config>` over a licensed fake client whose `link` offers Google and answers `accept`. */
async function licensedGate(accept: unknown) {
  const { fakeClient } = await import("./autoFixtures.js");
  const { adapter } = fakeClient(
    { kind: "unavailable", code: "refused" },
    {
      link: {
        pending: () => true,
        offer: async () => ({
          kind: "ok",
          offer: [{ kind: "google", reach: "global" }],
        }),
        accept: async () => accept,
        decline: async () => undefined,
        dismiss: () => undefined,
      },
    },
  );
  Object.assign(adapter.snapshot() as object, {
    status: "ok",
    gate: { status: "ok" },
  });
  const el = document.createElement("pk-gate") as HTMLElement & {
    seams?: unknown;
    updateComplete: Promise<unknown>;
  };
  el.setAttribute("config", '{"product":"acme"}');
  el.seams = { client: adapter as never };
  document.body.replaceChildren(el);
  await settle(el as never);
  return { adapter, el };
}

describe("the gate asks for the offer once the app is on screen", () => {
  it("shows the sheet after the one update that licenses the app (a phone has no second one)", async () => {
    const { el } = await licensedGate({ kind: "unavailable" });
    expect(el.shadowRoot!.querySelector("pk-sign-in")).not.toBeNull();
  });
});

describe("Sign in again on a stale offer, in the gate", () => {
  it("starts the gate's own sign-in", async () => {
    const { adapter, el } = await licensedGate({
      kind: "refused",
      status: 401,
      code: "step_up_required",
    });
    const form = el.shadowRoot!.querySelector("pk-sign-in") as PkSignIn;
    await press(form, "signin.linkOffer.primary");
    expect(keys(form)).toContain("signin.again");
    await press(form, "signin.again");
    expect(adapter.signInWithOidc).toHaveBeenCalledTimes(1);
  });
});
