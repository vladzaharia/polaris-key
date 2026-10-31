// @pkey-feature connect.links
//
// LinkPairingModel and TransferOfferModel (CC-19.9): the pairing window's steps over a fake driver,
// and consent per transfer (D-8). The rows of ui-matrix.json `connect` pin every view.

import { describe, expect, it } from "vitest";

import {
  categoryFallback,
  LinkPairingModel,
  shortName,
  TransferOfferModel,
  viewOf,
  type LinkPairingDriver,
  type LinkPairingOffer,
} from "../src/index.js";

const BASE = {
  platform: { os: "macos", formFactor: "mac" },
  presentation: { name: "Tidewater Studio", icon: true },
} as const;

type Pair = Parameters<LinkPairingDriver["pair"]>[0];

function fakeDriver(opts: { reject?: Error } = {}) {
  const log: string[] = [];
  const seen: { o: Pair | null } = { o: null };
  const driver: LinkPairingDriver = {
    async pair(o) {
      if (opts.reject) throw opts.reject;
      seen.o = o;
      log.push("pair");
      return { stop: async () => void log.push("stop") };
    },
    isUnavailable: (e) => (e as { code?: string }).code === "off",
  };
  return { driver, log, seen };
}

function offer(
  log: string[],
  over: Partial<LinkPairingOffer> = {},
): LinkPairingOffer {
  return {
    label: "Maya's laptop",
    code: "123 456",
    categories: ["contacts"],
    confirm: async () => void log.push("confirm"),
    decline: async () => void log.push("decline"),
    ...over,
  };
}

const make = (driver: LinkPairingDriver) =>
  new LinkPairingModel({ driver, categories: ["contacts"], base: BASE });

describe("LinkPairingModel", () => {
  it("is hidden until the window opens, then open", async () => {
    const f = fakeDriver();
    const m = make(f.driver);
    expect(m.view().state).toBe("hidden");
    await m.start();
    expect(m.view().state).toBe("open");
    expect(f.log).toEqual(["pair"]);
  });

  it("shows the code, the reported label and the categories before the choice", async () => {
    const f = fakeDriver();
    const m = make(f.driver);
    await m.start();
    f.seen.o!.onCode(offer(f.log));
    const v = m.view();
    expect(v.state).toBe("code");
    expect(v.copy).toContain("linkPairing.reported");
    expect(v.copy).toContain("linkPairing.shares");
    expect(v.args.device).toBe("Maya's laptop");
    expect(m.input().linkPairing).toMatchObject({
      code: "123 456",
      categories: ["contacts"],
    });
    // No default focus on the confirm button.
    expect(v.decisions.focus).toBe("heading");
  });

  it("says a missing label is missing", async () => {
    const f = fakeDriver();
    const m = make(f.driver);
    await m.start();
    f.seen.o!.onCode(offer(f.log, { label: null }));
    expect(m.view().copy).toContain("linkPairing.reportedUnnamed");
    expect(m.view().copy).not.toContain("linkPairing.reported");
  });

  it("confirm waits for the other person, then linked", async () => {
    const f = fakeDriver();
    const m = make(f.driver);
    await m.start();
    f.seen.o!.onCode(offer(f.log));
    await m.confirm();
    expect(m.view().state).toBe("confirm");
    f.seen.o!.onLinked({ label: "Maya's laptop", categories: ["contacts"] });
    expect(m.view().state).toBe("linked");
    expect(f.log).toContain("confirm");
  });

  it("keeps the code, the reported line and the categories while it waits for the other person", async () => {
    const f = fakeDriver();
    const m = make(f.driver);
    await m.start();
    f.seen.o!.onCode(offer(f.log));
    await m.confirm();
    const v = m.view();
    expect(v.state).toBe("confirm");
    expect(v.copy).toEqual(
      expect.arrayContaining([
        "linkPairing.waiting",
        "a11y.linkCode",
        "linkPairing.reported",
        "linkPairing.shares",
      ]),
    );
    expect(v.args).toMatchObject({ code: "123 456", device: "Maya's laptop" });
  });

  it("names who was paired when the device sent a label", async () => {
    const f = fakeDriver();
    const m = make(f.driver);
    await m.start();
    f.seen.o!.onCode(offer(f.log));
    await m.confirm();
    f.seen.o!.onLinked({ label: "Maya's laptop", categories: ["contacts"] });
    expect(m.view().copy).toContain("linkPairing.linkedWith");
    expect(m.view().args.device).toBe("Maya's laptop");
  });

  it("leads with Done, not Try again, when one device has no room for another pairing", async () => {
    const f = fakeDriver();
    const m = make(f.driver);
    await m.start();
    f.seen.o!.onCode(offer(f.log));
    f.seen.o!.onFailed({ reason: "full" });
    expect(m.view().decisions.primary).toBe("common.done");
    expect(m.view().copy).toContain("common.tryAgain");
  });

  it("shortens a long name in the middle, keeping the extension, and words a bare id", () => {
    const long = `${"a".repeat(70)}.zip`;
    const s = shortName(long);
    expect([...s].length).toBe(40);
    expect(s.endsWith(".zip")).toBe(true);
    expect(s).toContain("…");
    expect(shortName("holiday.zip")).toBe("holiday.zip");
    expect(categoryFallback("tax-forms")).toBe("Tax forms");
    expect(categoryFallback("photos")).toBe("Photos");
  });

  it("decline closes that session and the window stays open", async () => {
    const f = fakeDriver();
    const m = make(f.driver);
    await m.start();
    f.seen.o!.onCode(offer(f.log));
    await m.decline();
    expect(m.view().state).toBe("open");
    expect(f.log).toContain("decline");
    expect(f.log).not.toContain("stop");
  });

  it("offers one device at a time and declines the next", async () => {
    const f = fakeDriver();
    const m = make(f.driver);
    await m.start();
    f.seen.o!.onCode(offer(f.log, { code: "111 111" }));
    f.seen.o!.onCode(offer(f.log, { code: "222 222" }));
    expect(m.input().linkPairing?.code).toBe("111 111");
    expect(f.log).toEqual(["pair", "decline"]);
  });

  it.each(["declined", "timeout", "full", "closed"] as const)(
    "a session that reached the code and failed (%s) says why",
    async (reason) => {
      const f = fakeDriver();
      const m = make(f.driver);
      await m.start();
      f.seen.o!.onCode(offer(f.log));
      f.seen.o!.onFailed({ reason });
      const v = m.view();
      expect(v.state).toBe("failed");
      expect(m.input().linkPairing?.reason).toBe(reason);
      expect(v.copy).toContain(
        `linkPairing.failed${reason[0]!.toUpperCase()}${reason.slice(1)}`,
      );
    },
  );

  it("a failure nobody saw changes nothing", async () => {
    const f = fakeDriver();
    const m = make(f.driver);
    await m.start();
    f.seen.o!.onFailed({ reason: "closed" });
    expect(m.view().state).toBe("open");
  });

  it("links off for the product is its own state", async () => {
    const f = fakeDriver({
      reject: Object.assign(new Error("off"), { code: "off" }),
    });
    const m = make(f.driver);
    await m.start();
    expect(m.view().state).toBe("unavailable");
  });

  it("Try again opens a new window; a callback of the old one is dropped", async () => {
    const f = fakeDriver();
    const m = make(f.driver);
    await m.start();
    const old = f.seen.o!;
    old.onCode(offer(f.log));
    old.onFailed({ reason: "timeout" });
    await m.start();
    expect(m.view().state).toBe("open");
    old.onCode(offer(f.log));
    expect(m.view().state).toBe("open");
  });

  it("cancel closes the window and any session", async () => {
    const f = fakeDriver();
    const m = make(f.driver);
    await m.start();
    f.seen.o!.onCode(offer(f.log));
    await m.cancel();
    expect(f.log).toEqual(["pair", "decline", "stop"]);
    expect(m.view().state).toBe("hidden");
  });

  it("is hidden when Connect is off", async () => {
    const f = fakeDriver();
    const m = make(f.driver);
    await m.start();
    m.base = { ...BASE, services: ["license"] };
    expect(m.view().state).toBe("hidden");
  });
});

describe("TransferOfferModel", () => {
  const driverOf = (log: string[], fail = false) => ({
    accept: async () => {
      log.push("accept");
      if (fail) throw new Error("x");
    },
    decline: async () => void log.push("decline"),
    cancel: async () => void log.push("cancel"),
  });

  it("asks first, with the contact's label and the name it chose", () => {
    const m = new TransferOfferModel({
      driver: driverOf([]),
      device: "Maya's laptop",
      name: "holiday.zip",
      base: BASE,
    });
    const v = m.view();
    expect(v.state).toBe("ask");
    expect(v.copy).toContain("transferOffer.ask");
    expect(v.args).toMatchObject({
      device: "Maya's laptop",
      name: "holiday.zip",
    });
    expect(v.isolate).toEqual(["device", "name"]);
  });

  it("without a label it asks about a contact", () => {
    const m = new TransferOfferModel({
      driver: driverOf([]),
      name: "a.txt",
      base: BASE,
    });
    expect(m.view().copy).toContain("transferOffer.askUnnamed");
  });

  it("accept receives, then done", async () => {
    const log: string[] = [];
    const m = new TransferOfferModel({
      driver: driverOf(log),
      name: "a",
      base: BASE,
    });
    const p = m.accept();
    expect(m.view().state).toBe("receiving");
    await p;
    expect(m.view().state).toBe("done");
    await m.accept();
    expect(log).toEqual(["accept"]);
  });

  it("a failed receive says nothing was saved", async () => {
    const m = new TransferOfferModel({
      driver: driverOf([], true),
      name: "a",
      base: BASE,
    });
    await m.accept();
    expect(m.view().state).toBe("failed");
    expect(m.view().copy).toContain("transferOffer.failedBody");
  });

  it("decline answers once and closes", async () => {
    const log: string[] = [];
    const m = new TransferOfferModel({
      driver: driverOf(log),
      name: "a",
      base: BASE,
    });
    await m.decline();
    await m.decline();
    await m.accept();
    expect(log).toEqual(["decline"]);
    expect(m.view().state).toBe("hidden");
  });

  it("cancel stops a receive in flight", async () => {
    const log: string[] = [];
    let release: () => void = () => {};
    const m = new TransferOfferModel({
      driver: {
        accept: () => new Promise<void>((r) => (release = r)),
        decline: async () => {},
        cancel: async () => void log.push("cancel"),
      },
      name: "a",
      base: BASE,
    });
    const p = m.accept();
    await m.cancel();
    release();
    await p;
    expect(m.view().state).toBe("failed");
    expect(log).toEqual(["cancel"]);
  });
});

describe("viewOf answers the connect screens", () => {
  it("LinkPairing and TransferOffer", () => {
    expect(
      viewOf("LinkPairing", { ...BASE, linkPairing: { step: "open" } }).state,
    ).toBe("open");
    expect(
      viewOf("TransferOffer", {
        ...BASE,
        transferOffer: { step: "ask", name: "x" },
      }).state,
    ).toBe("ask");
  });
});
