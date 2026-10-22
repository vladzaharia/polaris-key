// @pkey-feature ui.cli.portal
// Discovery's `core.portal` in the Node SDK (plans/DISC-01.md §5): the store's persisted
// `portal.json`, and what a tampered file does. The parse and link rules are client-core's, run
// row by row against portal-matrix.json in conformance/runners/node/portal.test.ts.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PORTAL_MEMBER_FILE, PortalStore } from "../src/core/portal.js";

const ACTIVATE = "https://polaris.locker/activate?product=djdl";
const opts = () => ({
  product: "djdl",
  baseUrl: "https://key.plrs.im",
  dir: mkdtempSync(join(tmpdir(), "pkey-portal-")),
});
const file = (dir: string) => join(dir, PORTAL_MEMBER_FILE);

describe("PortalStore", () => {
  it("persists the member and reads it back on a cold start", async () => {
    const o = opts();
    const s = new PortalStore(o);
    await s.accept({ core: { portal: { enabled: true, activate: ACTIVATE } } });
    expect(s.current()).toEqual({ enabled: true, activate: ACTIVATE });
    const cold = new PortalStore(o);
    await cold.load();
    expect(cold.current()).toEqual({ enabled: true, activate: ACTIVATE });
  });

  it("a discovery without the member clears the memory and the file", async () => {
    const o = opts();
    const s = new PortalStore(o);
    await s.accept({ core: { portal: { enabled: false } } });
    expect(existsSync(file(o.dir))).toBe(true);
    await s.accept({ core: {} });
    expect(s.current()).toBeNull();
    expect(existsSync(file(o.dir))).toBe(false);
  });

  it("this session's discovery wins over a late load", async () => {
    const o = opts();
    await new PortalStore(o).accept({ core: { portal: { enabled: false } } });
    const s = new PortalStore(o);
    await s.accept({ core: { portal: { enabled: true, activate: ACTIVATE } } });
    await s.load();
    expect(s.current()).toEqual({ enabled: true, activate: ACTIVATE });
  });

  it.each([
    [
      "another product",
      {
        v: 1,
        product: "other",
        baseUrl: "https://key.plrs.im",
        portal: { enabled: false },
      },
    ],
    [
      "another base",
      {
        v: 1,
        product: "djdl",
        baseUrl: "https://other.example",
        portal: { enabled: false },
      },
    ],
    [
      "another version",
      {
        v: 2,
        product: "djdl",
        baseUrl: "https://key.plrs.im",
        portal: { enabled: false },
      },
    ],
    [
      "a link that is not valid",
      {
        v: 1,
        product: "djdl",
        baseUrl: "https://key.plrs.im",
        portal: { enabled: true, activate: "http://evil.example/x" },
      },
    ],
    [
      "a member that does not read back to itself",
      {
        v: 1,
        product: "djdl",
        baseUrl: "https://key.plrs.im",
        portal: { enabled: false, activate: ACTIVATE },
      },
    ],
  ])("deletes a file naming %s", async (_n, body) => {
    const o = opts();
    writeFileSync(file(o.dir), JSON.stringify(body));
    const s = new PortalStore(o);
    await s.load();
    expect(s.current()).toBeNull();
    expect(existsSync(file(o.dir))).toBe(false);
  });

  it("deletes a file that is not JSON", async () => {
    const o = opts();
    writeFileSync(file(o.dir), "{nope");
    const s = new PortalStore(o);
    await s.load();
    expect(s.current()).toBeNull();
    expect(existsSync(file(o.dir))).toBe(false);
    await s.accept({ core: { portal: { enabled: false } } });
    expect(JSON.parse(readFileSync(file(o.dir), "utf8")).portal).toEqual({
      enabled: false,
    });
  });
});
