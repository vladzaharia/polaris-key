// @pkey-feature ui.kit connect.links connect.transfer
//
// CC-19.L: LinkPairing and TransferOffer as elements. Layer (b): the host sets `input`, hears
// `pk-action` and `pk-close`; bound, the element runs ui-core's models over a host-supplied pairing
// driver or the browser SDK's `cloudConnect.transfer`. The matrix rows are matrix.test.ts's `connect`.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  LinkPairingDriver,
  LinkPairingOffer,
  UiInput,
} from "@polaris-key/ui-core";

import {
  TAGS,
  type OfferAnswer,
  type OfferInfo,
  type OfferSource,
  type PkActionDetail,
  type PkElement,
} from "../src/index.js";

// jsdom has no layout: an inert ResizeObserver.
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
});
afterEach(() => document.body.replaceChildren());

const BASE: UiInput = { elapsedMs: 60_000, services: ["identity", "connect"] };

async function mount(
  tag: "LinkPairing" | "TransferOffer",
  props: Record<string, unknown>,
): Promise<PkElement> {
  const el = document.createElement(TAGS[tag]) as PkElement;
  el.input = { ...BASE, ...((props["input"] as UiInput | undefined) ?? {}) };
  for (const [k, v] of Object.entries(props))
    if (k !== "input") (el as unknown as Record<string, unknown>)[k] = v;
  document.body.replaceChildren(el);
  await el.updateComplete;
  return el;
}
const q = (el: PkElement, sel: string) => el.shadowRoot!.querySelector(sel);
const keys = (el: PkElement, sel: string) =>
  [...el.shadowRoot!.querySelectorAll<HTMLElement>(sel)].map(
    (n) => n.dataset["key"],
  );
const settle = async (el: PkElement) => {
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
};
function heard(el: PkElement, type = "pk-action") {
  const seen: string[] = [];
  el.addEventListener(type, (e) =>
    seen.push((e as CustomEvent<PkActionDetail>).detail?.key ?? type),
  );
  return seen;
}
const escape = (el: PkElement) =>
  q(el, ".pk-root")!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );

const CODE_INPUT: UiInput = {
  linkPairing: {
    step: "code",
    code: "123 456",
    device: "Maya's laptop",
    categories: ["contacts", "tax-forms"],
  },
};

describe("pk-link-pairing", () => {
  it("lists what is shared before Codes match, and keeps the actions out of the dock", async () => {
    const el = await mount("LinkPairing", { input: CODE_INPUT });
    const root = el.shadowRoot!;
    const shares = q(el, '[data-part="shares"]')!;
    const confirm = q(el, '[data-key="linkPairing.confirm"]')!;
    expect(
      shares.compareDocumentPosition(confirm) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Not the card's direct child: the kit's docked action bar (`.card > .actions`) never applies.
    expect(q(el, ".card > .actions")).toBeNull();
    expect(root.querySelectorAll(".pair-cats li")).toHaveLength(2);
    // An id with no name is drawn as words; the label is isolated text.
    expect(q(el, '[data-key="category.tax-forms"]')!.textContent).toContain(
      "Tax forms",
    );
    expect(q(el, ".pair-reported bdi, .pair-reported")!.textContent).toContain(
      "Maya's laptop",
    );
  });

  it("names a category by the host's label", async () => {
    const el = await mount("LinkPairing", {
      input: CODE_INPUT,
      categoryLabels: { contacts: "Your contacts" },
    });
    expect(q(el, '[data-key="category.contacts"]')!.textContent).toContain(
      "Your contacts",
    );
  });

  it("spells the code out for a screen reader and takes no focus on arrival", async () => {
    const el = await mount("LinkPairing", { input: CODE_INPUT });
    const code = q(el, ".pair-code")!;
    expect(code.textContent).toBe("123 456");
    expect(code.getAttribute("aria-label")).toMatch(/1.*2.*3.*4.*5.*6/);
    // Enter on arrival never confirms a code nobody compared.
    expect(el.shadowRoot!.activeElement?.closest("button") ?? null).toBeNull();
    expect(
      q(el, '.btn[data-variant="primary"]')!.getAttribute("data-key"),
    ).toBe("linkPairing.confirm");
  });

  it("keeps the code and one live region from the code to the wait", async () => {
    const el = await mount("LinkPairing", { input: CODE_INPUT });
    const status = q(el, '[role="status"]')!;
    el.input = {
      ...BASE,
      linkPairing: { ...CODE_INPUT.linkPairing!, step: "confirm" },
    };
    await el.updateComplete;
    expect(q(el, ".pair-code")!.textContent).toBe("123 456");
    expect(q(el, '[role="status"]')).toBe(status);
    expect(status.textContent).toContain("Waiting");
    // The title is read; the words beside the dot are not announced again.
    expect(
      status.querySelector('[aria-hidden="true"]:not(.pair-dot)'),
    ).not.toBeNull();
    expect(el.shadowRoot!.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(keys(el, ".btn")).toEqual(["common.cancel"]);
  });

  it("an idle live region is empty, so the rhythm leaves it out", async () => {
    const el = await mount("LinkPairing", { input: CODE_INPUT });
    expect(q(el, ".pair-wait:empty")).not.toBeNull();
  });

  it("has sentence-case titles except the two names", async () => {
    const titles = async (step: string, extra = {}) =>
      q(
        await mount("LinkPairing", {
          input: { linkPairing: { step, categories: [], ...extra } },
        }),
        "h1",
      )!.textContent!.trim();
    expect(await titles("open")).toBe("Pair with Someone Nearby");
    expect(await titles("linked")).toBe("Paired");
    expect(await titles("unavailable")).toBe("Pairing is off");
    expect(await titles("code", { code: "1 2" })).toBe("Compare the code");
  });

  it("answers Escape with decline, cancel or done, and reports it", async () => {
    const act = async (input: UiInput) => {
      const el = await mount("LinkPairing", { input });
      const seen = heard(el);
      escape(el);
      return seen;
    };
    expect(await act(CODE_INPUT)).toEqual(["linkPairing.decline"]);
    expect(
      await act({ linkPairing: { step: "open", categories: [] } }),
    ).toEqual(["common.cancel"]);
    expect(
      await act({ linkPairing: { step: "linked", categories: [] } }),
    ).toEqual(["common.done"]);
  });

  it("says pk-close for Done and Cancel", async () => {
    const el = await mount("LinkPairing", {
      input: { linkPairing: { step: "linked", categories: [] } },
    });
    const closed = heard(el, "pk-close");
    (q(el, '[data-key="common.done"]') as HTMLElement).click();
    expect(closed).toHaveLength(1);
  });

  it("is drawn only with the connect service and a pairing", async () => {
    const off = await mount("LinkPairing", {
      input: {
        services: ["identity"],
        linkPairing: { step: "open", categories: [] },
      },
    });
    expect(q(off, ".pk-root")).toBeNull();
  });

  describe("driven by a host's pairing driver", () => {
    function pairing() {
      const calls = { confirm: 0, decline: 0, stop: 0 };
      let hooks!: Parameters<LinkPairingDriver["pair"]>[0];
      const driver: LinkPairingDriver = {
        pair: async (o) => {
          hooks = o;
          return { stop: async () => void calls.stop++ };
        },
      };
      const offer: LinkPairingOffer = {
        label: "Maya's laptop",
        code: "482 913",
        categories: ["contacts"],
        confirm: async () => void calls.confirm++,
        decline: async () => void calls.decline++,
      };
      return { driver, calls, offer, hooks: () => hooks };
    }

    it("runs the window: code, Codes match, linked, then closes it on removal", async () => {
      const p = pairing();
      const el = await mount("LinkPairing", {
        driver: p.driver,
        categories: ["contacts"],
        label: "My phone",
      });
      await settle(el);
      expect(el.view.state).toBe("open");
      p.hooks().onCode(p.offer);
      await settle(el);
      expect(el.view.state).toBe("code");
      const linked = heard(el, "pk-linked");
      (q(el, '[data-key="linkPairing.confirm"]') as HTMLElement).click();
      await settle(el);
      expect(p.calls.confirm).toBe(1);
      expect(el.view.state).toBe("confirm");
      p.hooks().onLinked({ label: "Maya's laptop", categories: ["contacts"] });
      await settle(el);
      expect(el.view.state).toBe("linked");
      expect(linked).toHaveLength(1);
      el.remove();
      await settle(el);
      expect(p.calls.stop).toBe(1);
    });

    it("Not a match declines that session and keeps the window open", async () => {
      const p = pairing();
      const el = await mount("LinkPairing", {
        driver: p.driver,
        categories: ["contacts"],
      });
      await settle(el);
      p.hooks().onCode(p.offer);
      await settle(el);
      (q(el, '[data-key="linkPairing.decline"]') as HTMLElement).click();
      await settle(el);
      expect(p.calls.decline).toBe(1);
      expect(el.view.state).toBe("open");
    });

    it("draws the typed 'links are off' as the neutral Pairing is off state", async () => {
      const driver: LinkPairingDriver = {
        pair: async () => {
          throw Object.assign(new Error("off"), {
            code: "connect_links_disabled",
          });
        },
        isUnavailable: (e) =>
          (e as { code?: string }).code === "connect_links_disabled",
      };
      const el = await mount("LinkPairing", { driver, categories: [] });
      await settle(el);
      expect(el.view.state).toBe("unavailable");
      expect(q(el, "h1")!.textContent!.trim()).toBe("Pairing is off");
      // The explanation comes before Done.
      expect(
        q(
          el,
          '[data-key="core.codes.connect_links_disabled.message"]',
        )!.compareDocumentPosition(q(el, '[data-key="common.done"]')!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });
});

describe("pk-transfer-offer", () => {
  const ASK: UiInput = {
    transferOffer: {
      step: "ask",
      name: "holiday.zip",
      device: "Maya's laptop",
    },
  };

  it("asks with the contact's label; the file is on its own row, middle elided, with size and type", async () => {
    const long = `${"a".repeat(120)}.zip`;
    const el = await mount("TransferOffer", {
      input: {
        transferOffer: {
          step: "ask",
          name: long,
          device: "Maya",
          size: 4_200_000,
          type: "application/zip",
        },
      },
    });
    expect(q(el, "h1")!.textContent!.trim()).toBe(
      "Maya wants to send you a file",
    );
    const row = q(el, ".pair-file")!;
    expect(row.textContent).toMatch(/….*\.zip$/);
    expect(row.textContent!.length).toBeLessThanOrEqual(48);
    expect(row.getAttribute("title")).toBe(long);
    expect(q(el, ".pair-meta")!.textContent!.trim()).toBe(
      "4.2 MB · application/zip",
    );
    expect(keys(el, ".btn").sort()).toEqual([
      "transferOffer.accept",
      "transferOffer.decline",
    ]);
  });

  it("draws a success mark when it was received", async () => {
    const el = await mount("TransferOffer", {
      input: { transferOffer: { step: "done", name: "a.zip", device: "M" } },
    });
    expect(q(el, ".success, [data-part='success']")).not.toBeNull();
  });

  it("shows a bar while it arrives, with Cancel", async () => {
    const el = await mount("TransferOffer", {
      input: {
        transferOffer: {
          step: "receiving",
          name: "holiday.zip",
          device: "Maya",
        },
      },
    });
    expect(q(el, '[role="progressbar"]')).not.toBeNull();
    expect(keys(el, ".btn")).toEqual(["common.cancel"]);
  });

  it("answers Escape with Decline or Done, and not while it arrives", async () => {
    const act = async (step: "ask" | "receiving" | "done") => {
      const el = await mount("TransferOffer", {
        input: { transferOffer: { step, name: "a.zip", device: "M" } },
      });
      const seen = heard(el);
      escape(el);
      return seen;
    };
    expect(await act("ask")).toEqual(["transferOffer.decline"]);
    // A transfer in flight is stopped by its Cancel, never by a stray key.
    expect(await act("receiving")).toEqual([]);
    expect(await act("done")).toEqual(["common.done"]);
  });

  it("sets no default focus on Accept", async () => {
    const el = await mount("TransferOffer", { input: ASK });
    expect(el.shadowRoot!.activeElement?.closest("button") ?? null).toBeNull();
  });

  describe("bound to cloudConnect.transfer", () => {
    function source() {
      let handler: ((o: OfferInfo) => Promise<OfferAnswer>) | null = null;
      let result: ((e: { id: string; outcome: string }) => void) | null = null;
      const cancelled: string[] = [];
      const src: OfferSource = {
        onOffer: (h) => {
          handler = h;
          return () => void (handler = null);
        },
        onResult: (fn) => {
          result = fn;
          return () => void (result = null);
        },
        cancel: (id) => (cancelled.push(id), true),
      };
      return {
        src,
        cancelled,
        offer: (o: OfferInfo) => handler!(o),
        result: (e: { id: string; outcome: string }) => result?.(e),
        bound: () => handler !== null,
      };
    }
    const OFFER: OfferInfo = {
      id: "t1",
      name: "holiday.zip",
      from: { label: "Maya's laptop" },
    };

    /** An offer has arrived and Accept was pressed. */
    async function accepted(s: ReturnType<typeof source>): Promise<PkElement> {
      const el = await mount("TransferOffer", {
        transfer: s.src,
        receive: () => undefined,
      });
      void s.offer(OFFER);
      await settle(el);
      (q(el, '[data-key="transferOffer.accept"]') as HTMLElement).click();
      await settle(el);
      return el;
    }

    it("declines without a prompt when the host gave no way to receive", async () => {
      const s = source();
      const el = await mount("TransferOffer", { transfer: s.src });
      expect(await s.offer(OFFER)).toBe("decline");
      await settle(el);
      expect(q(el, ".pk-root")).toBeNull();
    });

    it("asks per offer; Accept hands the verified content to the host", async () => {
      const s = source();
      const received: string[] = [];
      const el = await mount("TransferOffer", {
        transfer: s.src,
        receive: async (_b: Blob, o: OfferInfo) => void received.push(o.id),
      });
      const decision = s.offer(OFFER);
      await settle(el);
      expect(el.view.state).toBe("ask");
      expect(q(el, "h1")!.textContent).toContain("Maya's laptop");
      (q(el, '[data-key="transferOffer.accept"]') as HTMLElement).click();
      await settle(el);
      expect(el.view.state).toBe("receiving");
      const answer = (await decision) as { blob(b: Blob): Promise<void> };
      await answer.blob(new Blob(["x"]));
      await settle(el);
      expect(received).toEqual(["t1"]);
      expect(el.view.state).toBe("done");
      const closed = heard(el, "pk-close");
      (q(el, '[data-key="common.done"]') as HTMLElement).click();
      await settle(el);
      expect(closed).toHaveLength(1);
      expect(q(el, ".pk-root")).toBeNull();
    });

    it("Decline answers the SDK's handler and closes the prompt", async () => {
      const s = source();
      const el = await mount("TransferOffer", {
        transfer: s.src,
        receive: () => undefined,
      });
      const decision = s.offer(OFFER);
      await settle(el);
      (q(el, '[data-key="transferOffer.decline"]') as HTMLElement).click();
      expect(await decision).toBe("decline");
      await settle(el);
      expect(q(el, ".pk-root")).toBeNull();
    });

    it("a transfer that ends before it was delivered shows nothing was saved", async () => {
      const s = source();
      const el = await accepted(s);
      s.result({ id: "t1", outcome: "failed" });
      await settle(el);
      expect(el.view.state).toBe("failed");
    });

    it("Cancel while receiving stops the transfer", async () => {
      const s = source();
      const el = await accepted(s);
      (q(el, '[data-key="common.cancel"]') as HTMLElement).click();
      await settle(el);
      expect(s.cancelled).toEqual(["t1"]);
      expect(el.view.state).toBe("failed");
    });

    it("says pk-offer when an offer opens and pk-close only when nothing is waiting", async () => {
      const s = source();
      const el = await mount("TransferOffer", {
        transfer: s.src,
        receive: () => undefined,
      });
      const offered = heard(el, "pk-offer");
      const closed = heard(el, "pk-close");
      const first = s.offer(OFFER);
      const second = s.offer({ ...OFFER, id: "t2", name: "b.zip" });
      await settle(el);
      expect(offered).toHaveLength(1);
      (q(el, '[data-key="transferOffer.decline"]') as HTMLElement).click();
      expect(await first).toBe("decline");
      await settle(el);
      // The second is on screen, unanswered, and the host was not told to close.
      expect(closed).toEqual([]);
      expect(offered).toHaveLength(2);
      expect(q(el, ".pair-file")!.textContent).toContain("b.zip");
      (q(el, '[data-key="transferOffer.decline"]') as HTMLElement).click();
      expect(await second).toBe("decline");
      await settle(el);
      expect(closed).toHaveLength(1);
    });

    it("shows offers one at a time and declines what waits when it is removed", async () => {
      const s = source();
      const el = await mount("TransferOffer", {
        transfer: s.src,
        receive: () => undefined,
      });
      void s.offer(OFFER);
      const second = s.offer({ ...OFFER, id: "t2", name: "b.zip" });
      await settle(el);
      expect(q(el, ".pair-file")!.textContent).toContain("holiday.zip");
      el.remove();
      expect(await second).toBe("decline");
      expect(s.bound()).toBe(false);
    });
  });
});
