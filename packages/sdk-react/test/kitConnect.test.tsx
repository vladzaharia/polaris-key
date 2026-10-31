// @pkey-feature ui.kit
//
// CC-19.9: the inter-account screens in the React kit. LinkPairing runs the pairing window over a
// driver: the code is drawn as served and spelled out, the categories sit before Codes match in the
// DOM, nothing but the heading takes focus, the other device's label is isolated and worded as
// reported, Escape declines a code, and unmounting closes the window. TransferOffer answers one
// offer once (D-8). The matrix rows are kitMatrix's `connect` family.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  LinkPairingDriver,
  LinkPairingOffer,
  TransferOfferDriver,
} from "@polaris-key/ui-core";

import { LinkPairing, TransferOffer } from "../src/kit/connect.js";
import * as PublicKit from "../src/kit/index.js";
import { linkPairingDriver } from "../src/kit/connectHooks.js";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Pair = Parameters<LinkPairingDriver["pair"]>[0];

function fake() {
  const log: string[] = [];
  const seen: { o: Pair | null; n: number } = { o: null, n: 0 };
  const driver: LinkPairingDriver = {
    async pair(o) {
      seen.o = o;
      seen.n++;
      log.push("pair");
      return { stop: async () => void log.push("stop") };
    },
  };
  const offer = (over: Partial<LinkPairingOffer> = {}): LinkPairingOffer => ({
    label: "Maya's laptop",
    code: "123 456",
    categories: ["contacts", "photos"],
    confirm: async () => void log.push("confirm"),
    decline: async () => void log.push("decline"),
    ...over,
  });
  return { driver, log, seen, offer };
}

const ui = (extra: Record<string, unknown> = {}) => ({
  categories: ["contacts", "photos"],
  categoryLabels: { contacts: "Contacts", photos: "Photos" },
  ...extra,
});

async function opened(f: ReturnType<typeof fake>, props = {}) {
  const view = render(<LinkPairing driver={f.driver} {...ui(props)} />);
  await waitFor(() => expect(f.seen.o).not.toBeNull());
  return view;
}

describe("<LinkPairing>", () => {
  it("opens the window on mount and shows it is looking", async () => {
    const f = fake();
    await opened(f);
    expect(screen.getByText("Looking for nearby devices…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("draws the code, spells it out, and lists the categories before the choice", async () => {
    const f = fake();
    const { container } = await opened(f);
    act(() => f.seen.o!.onCode(f.offer()));
    const code = container.querySelector<HTMLElement>(".pair-code")!;
    expect(code.textContent).toBe("123 456");
    expect(code.getAttribute("aria-label")).toMatch(/Pairing code/);
    expect(code.getAttribute("aria-label")).toMatch(/1\D+2\D+3/);
    // The categories come before Codes match in the DOM, and so before Not a match.
    const cats = container.querySelector(".pair-cats")!;
    const confirm = screen.getByRole("button", { name: "Codes match" });
    expect(
      cats.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(cats.textContent).toContain("Contacts");
    expect(cats.textContent).toContain("Photos");
  });

  it("words the label as reported, isolated, and says when there is none", async () => {
    const f = fake();
    const { container } = await opened(f);
    act(() => f.seen.o!.onCode(f.offer()));
    const reported = container.querySelector(".pair-reported")!;
    expect(reported.textContent).toBe("Reported by the device: Maya's laptop");
    expect(reported.querySelector("bdi")?.textContent).toBe("Maya's laptop");
    act(() => f.seen.o!.onFailed({ reason: "closed" }));
    await waitFor(() => screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(f.seen.n).toBe(2));
    act(() => f.seen.o!.onCode(f.offer({ label: null })));
    expect(container.querySelector(".pair-reported")!.textContent).toBe(
      "The device gave no name",
    );
  });

  it("never focuses a control on arrival, so Enter cannot confirm", async () => {
    const f = fake();
    await opened(f);
    act(() => f.seen.o!.onCode(f.offer()));
    await waitFor(() => screen.getByRole("button", { name: "Codes match" }));
    expect(document.activeElement?.tagName).not.toBe("BUTTON");
  });

  it("Codes match confirms, waits, and ends on Paired", async () => {
    const f = fake();
    const onLinked = vi.fn();
    const onClose = vi.fn();
    await opened(f, { onLinked, onClose });
    act(() => f.seen.o!.onCode(f.offer()));
    fireEvent.click(screen.getByRole("button", { name: "Codes match" }));
    await waitFor(() =>
      expect(screen.getByText("Waiting for Them to Confirm")).toBeTruthy(),
    );
    expect(f.log).toContain("confirm");
    act(() =>
      f.seen.o!.onLinked({ label: "Maya's laptop", categories: ["contacts"] }),
    );
    await waitFor(() => expect(screen.getByText("Paired")).toBeTruthy());
    expect(onLinked).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(f.log).toContain("stop");
  });

  it("Not a match declines and the window stays open", async () => {
    const f = fake();
    await opened(f);
    act(() => f.seen.o!.onCode(f.offer()));
    fireEvent.click(screen.getByRole("button", { name: "Not a match" }));
    await waitFor(() =>
      expect(screen.getByText("Looking for nearby devices…")).toBeTruthy(),
    );
    expect(f.log).toContain("decline");
    expect(f.log).not.toContain("stop");
  });

  it("Escape on a code declines it", async () => {
    const f = fake();
    await opened(f);
    act(() => f.seen.o!.onCode(f.offer()));
    const root = document.querySelector<HTMLElement>(".pk-root")!;
    fireEvent.keyDown(root, { key: "Escape" });
    await waitFor(() => expect(f.log).toContain("decline"));
  });

  it("says why a session ended without a link", async () => {
    const f = fake();
    await opened(f);
    act(() => f.seen.o!.onCode(f.offer()));
    act(() => f.seen.o!.onFailed({ reason: "full" }));
    await waitFor(() =>
      expect(
        screen.getByText(
          "One of you has no room for another pairing. Remove one, then try again.",
        ),
      ).toBeTruthy(),
    );
  });

  it("closes the window when it unmounts", async () => {
    const f = fake();
    const { unmount } = await opened(f);
    unmount();
    await waitFor(() => expect(f.log).toContain("stop"));
  });

  it("links off for the product is the typed N/A, never a pairing screen", async () => {
    const driver = linkPairingDriver({
      pair: async () => {
        throw Object.assign(new Error("off"), {
          code: "connect_links_disabled",
        });
      },
    });
    render(<LinkPairing driver={driver} {...ui()} />);
    await waitFor(() =>
      expect(screen.getByText("Pairing is off")).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: "Codes match" })).toBeNull();
  });

  it("is the plain part given an input, and hidden without one", () => {
    const { container } = render(
      <LinkPairing
        input={{
          linkPairing: {
            step: "code",
            code: "123 456",
            device: "Ana",
            categories: ["contacts"],
          },
        }}
        categoryLabels={{ contacts: "Contacts" }}
      />,
    );
    expect(container.querySelector(".pair-code")?.textContent).toBe("123 456");
    cleanup();
    const none = render(<LinkPairing input={{}} />);
    expect(none.container.querySelector(".pk-root")).toBeNull();
  });
});

describe("<TransferOffer>", () => {
  const driverOf = () => {
    const log: string[] = [];
    const d: TransferOfferDriver = {
      accept: async () => void log.push("accept"),
      decline: async () => void log.push("decline"),
    };
    return { d, log };
  };

  it("asks with the contact's label and the name it chose; Accept receives", async () => {
    const { d, log } = driverOf();
    render(
      <TransferOffer driver={d} device="Maya's laptop" name="holiday.zip" />,
    );
    expect(
      screen.getByText((_, el) =>
        el?.getAttribute("data-key") === "transferOffer.ask"
          ? /Maya's laptop wants to send you holiday\.zip/.test(
              el.textContent ?? "",
            )
          : false,
      ),
    ).toBeTruthy();
    expect(document.activeElement?.tagName).not.toBe("BUTTON");
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(screen.getByText(/Received/)).toBeTruthy());
    expect(log).toEqual(["accept"]);
  });

  it("Decline answers once and closes", async () => {
    const { d, log } = driverOf();
    const onClose = vi.fn();
    render(
      <TransferOffer driver={d} device="Ana" name="a.txt" onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(log).toEqual(["decline"]);
  });

  it("a contact with no label is a paired device", () => {
    const { d } = driverOf();
    render(<TransferOffer driver={d} name="a.txt" />);
    expect(
      document.querySelector('[data-key="transferOffer.askUnnamed"]')
        ?.textContent,
    ).toBe("A paired device wants to send you a.txt");
  });
});

describe("the public kit", () => {
  it("exports both screens, lazily, and the hooks", async () => {
    expect(PublicKit.LinkPairing).toBeTypeOf("function");
    expect(PublicKit.TransferOffer).toBeTypeOf("function");
    expect(PublicKit.useLinkPairing).toBeTypeOf("function");
    expect(PublicKit.linkPairingDriver).toBeTypeOf("function");
    render(
      <PublicKit.LinkPairing
        input={{ linkPairing: { step: "open", categories: [] } }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("Looking for nearby devices…")).toBeTruthy(),
    );
  });
});
