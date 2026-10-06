// @vitest-environment node
//
// @pkey-feature outlet.detect
// Outlet detection in the React SDK (plans/P3-01.md §2.9). The mapping is client-core's
// `detectOutlet`, which this package re-exports and runs unchanged: every row of
// `conformance/corpus/v2/outlet-matrix.json` runs here through the React export, as in the Node
// runner. What only this file proves is the page's reader (`readOutletSignals`, over a faked
// page) and the adapter's wiring: with no host outlet the adapter detects in-page and passes the
// result to `resolveUpdateOutlet` as `detected`; a host value always wins.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as core from "@polaris-key/client-core";
import {
  BrowserAdapter,
  detectOutlet,
  detectionStamp,
  readOutletSignals,
} from "../src/index.js";
import { WEB_OUTLET_STAMP } from "../src/browser/browserAdapter.js";

const here = dirname(fileURLToPath(import.meta.url));
const matrix = JSON.parse(
  readFileSync(
    join(here, "../../../conformance/corpus/v2/outlet-matrix.json"),
    "utf8",
  ),
) as {
  rows: {
    name: string;
    stamp: core.DetectionStamp | null;
    signals: Record<string, unknown>;
    expect: core.DetectedOutlet;
  }[];
};

describe("outlet-matrix.json through the React export", () => {
  it("is client-core's function, not a copy", () => {
    expect(detectOutlet).toBe(core.detectOutlet);
    expect(detectionStamp).toBe(core.detectionStamp);
  });
  for (const row of matrix.rows)
    it(`row ${row.name}`, () => {
      expect(detectOutlet({ stamp: row.stamp, signals: row.signals })).toEqual(
        row.expect,
      );
    });
});

describe("readOutletSignals (a faked page)", () => {
  const media =
    (standalone: boolean) =>
    (q: string): { matches: boolean } => ({
      matches: standalone && q === "(display-mode: standalone)",
    });

  it("reads an installed app window (display-mode: standalone) as standalone", () => {
    expect(
      readOutletSignals({ matchMedia: media(true), navigator: {} }),
    ).toEqual({ "web.displayMode": "standalone" });
  });
  it("reads iOS Safari's home-screen app (navigator.standalone === true) as standalone", () => {
    expect(
      readOutletSignals({
        matchMedia: media(false),
        navigator: { standalone: true },
      }),
    ).toEqual({ "web.displayMode": "standalone" });
  });
  it("reads a Trusted Web Activity's android-app:// referrer as standalone", () => {
    expect(
      readOutletSignals({
        matchMedia: media(false),
        referrer: "android-app://gg.vlad.diceroll/",
      }),
    ).toEqual({ "web.displayMode": "standalone" });
  });
  it("reads a tab as browser; desktop WebKit's navigator.standalone false counts for nothing", () => {
    expect(
      readOutletSignals({
        matchMedia: media(false),
        navigator: { standalone: false },
        referrer: "https://example.com/",
      }),
    ).toEqual({ "web.displayMode": "browser" });
  });
  it("records nothing where the display cannot be read, and survives a throwing matchMedia", () => {
    expect(readOutletSignals({})).toEqual({});
    expect(
      readOutletSignals({
        matchMedia: () => {
          throw new Error("no media");
        },
      }),
    ).toEqual({ "web.displayMode": "browser" });
  });
  it("the web stamp plus either value detects web (heuristic, web.displayMode)", () => {
    for (const env of [
      { matchMedia: media(true) },
      { matchMedia: media(false) },
    ])
      expect(
        detectOutlet({
          stamp: detectionStamp(WEB_OUTLET_STAMP),
          signals: readOutletSignals(env),
        }),
      ).toEqual({
        kind: "web",
        confidence: "heuristic",
        source: "web.displayMode",
        subkind: null,
      });
  });
});

describe("BrowserAdapter — the detected outlet is the default", () => {
  const make = (
    update: ConstructorParameters<typeof BrowserAdapter>[0]["update"],
  ): BrowserAdapter =>
    new BrowserAdapter({
      auth: "cookie",
      productSlug: "djdl",
      fetchImpl: (async () =>
        new Response(null, { status: 404 })) as unknown as typeof fetch,
      offlineStore: null,
      update,
    });
  const keys = { k: "A".repeat(43) };

  it("detects in-page when the host names no outlet", () => {
    const a = make({
      pinnedReleaseKeys: keys,
      outletEnvironment: {
        matchMedia: (q) => ({ matches: q === "(display-mode: standalone)" }),
      },
    });
    expect(a.detected).toEqual({
      kind: "web",
      confidence: "heuristic",
      source: "web.displayMode",
      subkind: null,
    });
    expect(a.outlet).toEqual({ id: "web", kind: "web", subkind: null });
  });

  it("uses the host's outlet when it names one, and detects nothing", () => {
    const a = make({
      pinnedReleaseKeys: keys,
      outlet: { id: "web-beta", kind: "web" },
      outletEnvironment: { matchMedia: () => ({ matches: true }) },
    });
    expect(a.detected).toBeNull();
    expect(a.outlet).toEqual({ id: "web-beta", kind: "web", subkind: null });
  });

  it("uses a host detection result as given, and the stamp alone with detect: false", () => {
    const given = make({
      pinnedReleaseKeys: keys,
      detected: {
        kind: "unknown",
        confidence: null,
        source: null,
        subkind: null,
      },
    });
    expect(given.outlet).toEqual({ id: null, kind: "unknown", subkind: null });
    const off = make({ pinnedReleaseKeys: keys, detect: false });
    expect(off.detected).toBeNull();
    expect(off.outlet).toEqual({ id: "web", kind: "web", subkind: null });
  });

  it("has neither without update options", () => {
    const a = make(undefined);
    expect(a.outlet).toBeNull();
    expect(a.detected).toBeNull();
  });
});
