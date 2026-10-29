// client-core's proof for the LAN address rule (WIRE-CONTRACT-V5 §15.4.1, plans/CC-IPV6.md): every
// row of `conformance/corpus/v2/peer-matrix.json` `lanAddresses`, which the corpus generator
// recomputed with its own reference (tools/corpus/reference/lanAddress.ts). Then the edges the
// corpus cannot carry.
// @pkey-feature connect.lan
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  candidateTarget,
  lanGroupKey,
  lanVerdict,
  type LocalInterfaceAddress,
} from "../src/peer/index.js";

interface Row {
  id: string;
  remote: string;
  local?: string;
  allowLoopback: boolean;
  dial: boolean;
  key: string | null;
  group: string | null;
}

interface CandidateRow {
  id: string;
  entry: string;
  interfaces: LocalInterfaceAddress[];
  target: { host: string; port: number } | null;
}

const MATRIX = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "conformance",
      "corpus",
      "v2",
      "peer-matrix.json",
    ),
    "utf8",
  ),
) as {
  lanAddresses: { rows: Row[]; candidates: { rows: CandidateRow[] } };
};

/** Exact: a row added or dropped is a deliberate corpus change. */
function pinRows(rows: { id: string }[], count: number): void {
  it("has the rows", () => {
    expect(rows.length).toBe(count);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });
}
const byId = <T extends { id: string }>(rows: T[]) =>
  rows.map((r) => [r.id, r] as const);

describe("lanVerdict: peer-matrix lanAddresses", () => {
  const rows = MATRIX.lanAddresses.rows;
  pinRows(rows, 133);
  it.each(byId(rows))("%s", (_id, r) => {
    expect(lanVerdict(r.remote, r.local, r.allowLoopback)).toEqual({
      dial: r.dial,
      key: r.key,
    });
    expect(lanGroupKey(r.key)).toBe(r.group);
  });
});

describe("candidateTarget: peer-matrix lanAddresses.candidates", () => {
  const rows = MATRIX.lanAddresses.candidates.rows;
  pinRows(rows, 73);
  it.each(byId(rows))("%s", (_id, r) => {
    expect(candidateTarget(r.entry, r.interfaces)).toEqual(r.target);
  });
});

describe("lanVerdict: edges", () => {
  it("treats an absent and a null local alike", () => {
    expect(lanVerdict("2001:db8::1", null, false)).toEqual(
      lanVerdict("2001:db8::1", undefined, false),
    );
  });

  it("never gives a key for a refusal", () => {
    for (const a of ["8.8.8.8", "::", "ff02::fb", "not an address", ""])
      expect(lanVerdict(a, "2001:db8::2", true)).toEqual({
        dial: false,
        key: null,
      });
  });

  it("keeps the zone in a link-local key only", () => {
    expect(lanVerdict("fe80::1%en0", null, false).key).toBe("fe80::1%en0");
    expect(lanVerdict("fe80::1%en1", null, false).key).not.toBe(
      lanVerdict("fe80::1%en0", null, false).key,
    );
    expect(lanVerdict("fd00::1%en0", null, false).key).toBe("fd00::1");
  });

  it("gives one /64 key to the addresses of one /64", () => {
    const g = (a: string) =>
      lanGroupKey(lanVerdict(a, "fd00:1:2:3::9", false).key);
    expect(g("fd00:1:2:3::5")).toBe(g("fd00:1:2:3:0:0:0:6"));
    expect(g("fd00:1:2:3::5")).toBe("fd00:1:2:3::/64");
    expect(lanGroupKey(null)).toBeNull();
  });

  it("groups a link-local key by link, an IPv4 key by /24 and the rest by /64", () => {
    // fe80::/10 holds 2^54 /64s: the group is the link, whatever the /64 of the address.
    expect(lanGroupKey("fe80::1%en0")).toBe("fe80::/10%en0");
    expect(lanGroupKey("febf:1:2:3::9%en0")).toBe("fe80::/10%en0");
    expect(lanGroupKey("fe80::1%en1")).toBe("fe80::/10%en1");
    expect(lanGroupKey("fe80::1")).toBe("fe80::/10");
    expect(lanGroupKey("10.0.0.1")).toBe("10.0.0.0/24");
    expect(lanGroupKey("10.0.0.254")).toBe("10.0.0.0/24");
    expect(lanGroupKey("10.0.1.1")).toBe("10.0.1.0/24");
    expect(lanGroupKey("192.168.1.2")).toBe("192.168.1.0/24");
    expect(lanGroupKey("2001:db8:1:2::5")).toBe("2001:db8:1:2::/64");
    expect(lanGroupKey("fd00:1:2:3::5")).toBe("fd00:1:2:3::/64");
    expect(lanGroupKey("not an address")).toBeNull();
  });

  it("keeps the dial rule off loopback and a mapped zone, whatever the flag", () => {
    expect(lanVerdict("::ffff:127.0.0.1%lo", null, true).dial).toBe(false);
    expect(lanVerdict("127.0.0.1", null, false).dial).toBe(false);
  });

  it("keys on the full address, not the /64", () => {
    const a = lanVerdict("fd00:1:2:3::5", null, false).key;
    const b = lanVerdict("fd00:1:2:3::6", null, false).key;
    expect(a).not.toBe(b);
  });

  it("gives one key to every spelling of an address", () => {
    const spellings = [
      "FD00:0:0:0:0:0:0:5",
      "fd00::5",
      "fd00::5%en0",
      "fd00::0.0.0.5",
    ];
    expect(
      new Set(spellings.map((s) => lanVerdict(s, null, false).key)),
    ).toEqual(new Set(["fd00::5"]));
  });

  it("does not let a local global address on the same /64 widen a link-local verdict", () => {
    expect(lanVerdict("fe80::1", "2001:db8:1:2::9", false).key).toBe("fe80::1");
    expect(lanVerdict("2001:db8:1:2::5", "fe80::9", false).dial).toBe(false);
  });
});
