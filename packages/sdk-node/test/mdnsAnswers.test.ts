// @pkey-feature connect.lan
// The Node runner for `conformance/corpus/v2/peer-matrix.json` `mdnsAnswers` (WIRE-CONTRACT-V5
// §15.4 Addresses, CC-IPV6.3): each row's packet is decoded by the DNS codec the adapter uses
// (`dns-packet`, through `multicast-dns`), its A and AAAA records are fed to the adapter's
// `AddressBook` with the row's source and zone, and the table must equal `learned`. A row's
// optional `prior` is the table held before the packet.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AddressBook, MAX_ADDRS } from "../src/connect/mdns.js";

const here = dirname(fileURLToPath(import.meta.url));
const matrix = JSON.parse(
  readFileSync(
    join(here, "../../../conformance/corpus/v2/peer-matrix.json"),
    "utf8",
  ),
) as { mdnsAnswers: { rows: Row[] } };

interface Entry {
  name: string;
  address: string;
}
interface Row {
  id: string;
  packet: string;
  source: string;
  zone: string | null;
  prior?: Entry[];
  learned: Entry[];
}

// `dns-packet` is multicast-dns's own decoder; resolve it from there.
const viaMdns = createRequire(
  createRequire(import.meta.url).resolve("multicast-dns"),
);
const dns = viaMdns("dns-packet") as {
  decode(b: Buffer): {
    answers: { name: string; type: string; ttl: number; data: unknown }[];
    additionals: { name: string; type: string; ttl: number; data: unknown }[];
  };
};

/** The table grouped by name: the order across names carries no meaning, the order within one does. */
const grouped = (t: Entry[]): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const e of t) (out[e.name] ??= []).push(e.address);
  return out;
};

describe("peer-matrix mdnsAnswers", () => {
  it("has the rows this runner covers", () => {
    expect(matrix.mdnsAnswers.rows.length).toBeGreaterThanOrEqual(36);
    expect(MAX_ADDRS).toBe(4);
  });

  for (const r of matrix.mdnsAnswers.rows)
    it(r.id, () => {
      const book = new AddressBook();
      for (const p of r.prior ?? []) book.hold(p.name, p.address);
      const msg = dns.decode(Buffer.from(r.packet, "hex"));
      for (const a of [...msg.answers, ...msg.additionals])
        if ((a.type === "A" || a.type === "AAAA") && typeof a.data === "string")
          book.learn(
            { name: a.name, type: a.type, ttl: a.ttl, data: a.data },
            r.source,
            r.zone,
            0,
          );
      expect(grouped(book.table())).toEqual(grouped(r.learned));
    });
});
