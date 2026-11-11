// @pkey-feature connect.local
//
// CC-29K: Pair with a Code and the paired devices in the React kit, driven over a fake
// `LocalLinksLike`. The matrix rows are kitMatrix's `local` family; this suite holds what a row
// cannot: the show screen's code is drawn as served and spelled out, with its QR; the field answers
// a press on an unavailable Pair under itself; a wrong code keeps the first two digits; the prompt
// ignores Pair for its first 250 ms; Rename and Forget work in the row; Escape is Not now, Cancel or
// Back by screen.

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
  LocalCodeLike,
  LocalLinkLike,
  LocalOfferLike,
  LocalPairedLike,
} from "@polaris-key/ui-core";

import { LocalPairing, PairedDevices } from "../src/kit/localPairing.js";
import * as PublicKit from "../src/kit/index.js";
import type {
  LocalLinksLike,
  UseLocalPairing,
  UseLocalPairingOptions,
  UsePairedDevices,
  UsePairedDevicesOptions,
} from "../src/kit/index.js";

class QuietObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", QuietObserver);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type PairArgs = Parameters<LocalLinksLike["pair"]>[0];
type JoinArgs = Parameters<LocalLinksLike["join"]>[0];

const code = (c: string, reason = "opened"): LocalCodeLike => ({
  code: c,
  qr: "PKP1:DJDL:P1-ABCDEFGHIJKLMNOP:7KQ2M5TXNRB4WV3Y",
  reason,
  expiresAt: Math.ceil(Date.now() / 1000) + 300,
  failures: 0,
});

function fake(rows: LocalLinkLike[] = []) {
  const log: string[] = [];
  const seen: { pair: PairArgs | null; join: JoinArgs | null } = {
    pair: null,
    join: null,
  };
  const next = {
    join: (): Promise<LocalPairedLike> => new Promise(() => undefined),
  };
  let list = rows;
  const driver: LocalLinksLike = {
    localPairing: () => true,
    list: async () => list,
    rename: async (id, label) => {
      log.push(`rename ${id} ${label}`);
      list = list.map((r) => (r.id === id ? { ...r, label } : r));
      return true;
    },
    remove: async (id) => {
      log.push(`remove ${id}`);
      list = list.filter((r) => r.id !== id);
      return true;
    },
    setReachable: async (id, on) => {
      log.push(`reachable ${id} ${on}`);
      list = list.map((r) => (r.id === id ? { ...r, reachable: on } : r));
      return true;
    },
    onChange: () => () => undefined,
    dialsLeft: () => null,
    pair: async (o) => {
      seen.pair = o;
      log.push("pair");
      return {
        open: true,
        stop: async () => void log.push("stop"),
        renew: async () => code("5512 0000"),
        code: () => null,
      };
    },
    join: (o) => {
      seen.join = o;
      log.push(`join ${o.code}`);
      return next.join();
    },
  };
  return { driver, log, seen, next };
}

const offer = (log: string[]): LocalOfferLike => ({
  label: "LAPTOP-7QH3RX",
  categories: ["crates"],
  confirm: async () => void log.push("confirm"),
  decline: async () => void log.push("decline"),
});

const THEME = { product: { name: "DJDL" } };
const props = { categories: ["crates"], categoryLabels: { crates: "Crates" } };

type Fake = ReturnType<typeof fake>;

/** The pairing screen over `f`, and the one press that opens a role of it. */
function pairing(f: Fake, extra: Record<string, unknown> = {}) {
  return render(
    <LocalPairing driver={f.driver} {...props} theme={THEME} {...extra} />,
  );
}
const press = async (name: string | RegExp) =>
  fireEvent.click(await screen.findByRole("button", { name }));
const codeField = async () =>
  (await screen.findByLabelText("Code")) as HTMLInputElement;
/** Show a code, and hand back the first code the shower is given. */
async function shown(f: Fake, text = "4812 3456") {
  const view = pairing(f);
  await press(/Show a code/);
  await waitFor(() => expect(f.seen.pair).not.toBeNull());
  act(() => f.seen.pair!.onCode(code(text)));
  return view;
}
const joins = (f: Fake) => f.log.filter((l) => l.startsWith("join")).length;

describe("<LocalPairing>", () => {
  it("shows the code as served, spelled out, beside its QR; Enter a code instead withdraws it", async () => {
    const f = fake();
    const { container } = await shown(f);
    const drawn = container.querySelector('[data-key="a11y.linkCode"]')!;
    expect(drawn.textContent).toBe("4812 3456");
    expect(drawn.getAttribute("aria-label")).toContain("4 8 1 2");
    expect(container.querySelector(".qr svg")).not.toBeNull();
    await press("Enter a code instead");
    await waitFor(() => expect(f.log).toContain("stop"));
    expect(await codeField()).not.toBeNull();
    expect(container.querySelector(".qr")).toBeNull();
  });

  it("a wrong code lights the new digits, says so, and announces the new code", async () => {
    const f = fake();
    const { container } = await shown(f);
    act(() => f.seen.pair!.onCode(code("4873 0691", "wrong-code")));
    expect(await screen.findByText("Wrong code entered")).not.toBeNull();
    expect(container.querySelectorAll(".pair-lit")).toHaveLength(6);
    expect(container.querySelector(".pair-live")?.textContent).toContain(
      "New code 4873 0691",
    );
    expect(
      screen.getByRole("button", { name: "Show a new code" }),
    ).toBeTruthy();
  });

  it("Pair under 8 digits answers under the field and sends nothing; a wrong code keeps 48", async () => {
    const f = fake();
    const { container } = pairing(f);
    await press(/Enter a code/);
    const field = await codeField();
    fireEvent.change(field, { target: { value: "4812" } });
    const short = screen.getByRole("button", { name: "Pair" });
    expect(short.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(short);
    expect(await screen.findByText("A code is 8 digits.")).toBeTruthy();
    expect(f.seen.join).toBeNull();
    fireEvent.change(field, { target: { value: "48123456" } });
    expect(field.value).toBe("4812 3456");
    f.next.join = async () => {
      throw Object.assign(new Error("x"), {
        code: "pairing-code-failed",
        reason: "wrong",
      });
    };
    await press("Pair");
    expect(await screen.findByText(/That code didn.t work/)).toBeTruthy();
    expect(field.value).toBe("48");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    // The code that failed is not offered again until it differs: a press answers instead.
    fireEvent.change(field, { target: { value: "48123456" } });
    const stale = screen.getByRole("button", { name: "Pair" });
    expect(stale.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(stale);
    await waitFor(() =>
      expect(
        container.querySelector("[data-key='localPairing.wrongCode']"),
      ).toBeTruthy(),
    );
    expect(joins(f)).toBe(1);
  });

  it("the prompt names the other device, isolated, and ignores Pair for 250 ms", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fake();
    const { container } = pairing(f);
    const settle = (ms: number) =>
      act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
    await settle(0);
    fireEvent.click(screen.getByRole("button", { name: /Show a code/ }));
    await settle(0);
    act(() => f.seen.pair!.onCode(code("4812 3456")));
    act(() => f.seen.pair!.onConfirm(offer(f.log)));
    expect(container.querySelector("h1 bdi")?.textContent).toBe(
      "LAPTOP-7QH3RX",
    );
    // The categories come before Pair in the DOM: pressing Pair is the consent.
    const html = container.innerHTML;
    expect(html.indexOf("Crates")).toBeLessThan(
      html.indexOf('data-key="localPairing.pair"'),
    );
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    expect(f.log).not.toContain("confirm");
    await settle(260);
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    expect(f.log).toContain("confirm");
  });

  it("Escape is Back on the field, Cancel while pairing, Not now on the prompt", async () => {
    const f = fake();
    const { container } = pairing(f);
    await press(/Enter a code/);
    fireEvent.keyDown(await codeField(), { key: "Escape" });
    await press(/Enter a code/);
    fireEvent.change(await codeField(), { target: { value: "48123456" } });
    await press("Pair");
    await waitFor(() => expect(f.seen.join).not.toBeNull());
    expect(container.querySelector('[data-key="common.cancel"]')).toBeTruthy();
    fireEvent.keyDown(container.querySelector(".pk-root")!, { key: "Escape" });
    await waitFor(() => expect(f.seen.join!.signal.aborted).toBe(true));
  });
});

const seenAgo = (days: number): number =>
  Math.floor(Date.now() / 1000) - days * 86_400;
const link = (
  id: string,
  over: Partial<LocalLinkLike> = {},
): LocalLinkLike => ({
  id,
  label: `Device ${id}`,
  lastSeen: seenAgo(3),
  reachable: true,
  ...over,
});
const devices = (f: Fake, extra: Record<string, unknown> = {}) =>
  render(<PairedDevices driver={f.driver} theme={THEME} {...extra} />);
/** Open a row's menu and pick one of its two items. */
function fromMenu(root: HTMLElement, id: string, key: string): void {
  fireEvent.click(root.querySelector(`[data-row="${id}"] .pair-more`)!);
  fireEvent.click(
    root.querySelector(`[data-row="${id}"] button[data-key="${key}"]`)!,
  );
}

describe("<PairedDevices>", () => {
  it("lists the devices with their names isolated and Last seen; no switches while all are on", async () => {
    const { container } = devices(fake([link("a"), link("b")]));
    expect(await screen.findByText("Device a")).toBeTruthy();
    expect(container.querySelector(".pair-name bdi")?.textContent).toBe(
      "Device a",
    );
    expect(container.textContent).toContain("Last seen");
    expect(container.querySelector('[role="switch"]')).toBeNull();
  });

  it("shows the switches once one is off, and a press turns it on", async () => {
    const f = fake([link("a"), link("b", { reachable: false })]);
    devices(f);
    const off = await screen.findByRole("switch", {
      name: "Let Device b connect to this device",
    });
    expect(off.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(off);
    await waitFor(() => expect(f.log).toContain("reachable b true"));
  });

  it("renames in the row: a refused name keeps its text; Save writes it", async () => {
    const f = fake([link("a"), link("b")]);
    const { container } = devices(f);
    await screen.findByText("Device a");
    fromMenu(container, "a", "devices.rename");
    const name = (await screen.findByLabelText(
      "Device name",
    )) as HTMLInputElement;
    expect(name.value).toBe("Device a");
    fireEvent.change(name, { target: { value: "x".repeat(65) } });
    await press("Save");
    expect(await screen.findByText("Use 64 characters or fewer.")).toBeTruthy();
    expect(name.value).toHaveLength(65);
    fireEvent.change(name, { target: { value: "Riverside" } });
    await press("Save");
    await waitFor(() => expect(f.log).toContain("rename a Riverside"));
    expect(await screen.findByText("Riverside")).toBeTruthy();
  });

  it("forgets in the row and moves focus to the next row", async () => {
    const f = fake([link("a"), link("b")]);
    const { container } = devices(f);
    await screen.findByText("Device a");
    fromMenu(container, "a", "pairedDevices.forget");
    await waitFor(() =>
      expect(
        container.querySelector('[data-key="pairedDevices.forgetConfirm"]')
          ?.textContent,
      ).toBe("Forget Device a?"),
    );
    fireEvent.click(
      container.querySelector(
        '[data-editing="forget"] button[data-key="pairedDevices.forget"]',
      )!,
    );
    await waitFor(() => expect(f.log).toContain("remove a"));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        container.querySelector('[data-row="b"] .pair-more'),
      ),
    );
  });

  it("with 32 paired, Pair with a Code is unavailable and says why", async () => {
    const full = Array.from({ length: 32 }, (_, i) =>
      link(`d${i}`, { reachable: i < 8 }),
    );
    const onPair = vi.fn();
    devices(fake(full), { onPair });
    await screen.findByText("No room to pair");
    const pair = screen.getByRole("button", { name: "Pair with a Code" });
    expect(pair.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(pair);
    expect(onPair).not.toHaveBeenCalled();
  });
});

describe("the headless hooks", () => {
  it("are public, and hold the models: the list is read on mount and the gate and cap say so", async () => {
    expect(PublicKit.LocalPairing).toBeTypeOf("function");
    expect(PublicKit.PairedDevices).toBeTypeOf("function");
    const f = fake([link("a", { lastSeen: null })]);
    const seen: { pair?: UseLocalPairing; list?: UsePairedDevices } = {};
    function Probe(props: {
      pair: UseLocalPairingOptions;
      list: UsePairedDevicesOptions;
    }) {
      seen.pair = PublicKit.useLocalPairing(props.pair);
      seen.list = PublicKit.usePairedDevices(props.list);
      return null;
    }
    render(
      <Probe
        pair={{ driver: f.driver, categories: ["crates"] }}
        list={{ driver: f.driver }}
      />,
    );
    await waitFor(() => expect(seen.list!.snapshot.loaded).toBe(true));
    expect(seen.list!.view.state).toBe("list");
    expect(seen.pair!.view.state).toBe("choose");
    await act(async () => seen.pair!.model.enter());
    expect(seen.pair!.snapshot.step).toBe("enter");
  });
});
