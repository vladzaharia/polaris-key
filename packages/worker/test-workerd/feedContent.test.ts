/// <reference types="@cloudflare/workers-types" />
// ── Feed content composition on workerd (P4-13, plans/P4-13.md §6.3 "Cost") ────────────────
//
// The Node lane proves the shedding order (`test/feedContentSize.test.ts`). This proves that the
// largest legal content part — 64 packs with 64-byte ids × 3 live levels × 2 engines × 6
// platforms, every pack floored at every level, 64 revocations — is fitted under the payload cap,
// checked with client-core's `feedContent` and the v4 claims inside the isolate, for every
// platform, within the CPU budget, with the app part intact.

import { describe, expect, it } from "vitest";
import { packSetId } from "@polaris-key/client-core/packs";
import type { FeedPackRow, FeedTarget } from "@polaris-key/protocol/update";
import { documentFor, feedSelfCheck } from "../src/services/update/feedDoc.js";
import type { ComposedFeed } from "../src/services/update/compose.js";

const PLATFORMS = ["macos", "windows", "linux", "android", "ios", "web"];

async function hex(s: string): Promise<string> {
  const d = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
  );
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const packId = (i: number): string => {
  const base = `pk${String(i).padStart(3, "0")}`;
  return `${base}.${"a".repeat(64 - base.length - 1)}`;
};

async function worstCase(): Promise<ComposedFeed> {
  const releases: Record<
    string,
    { pack: string; version: string; seq: number }
  > = {};
  const sets: Record<string, string[]> = {};
  const rows: FeedPackRow[] = [];
  for (let level = 3; level < 6; level++)
    for (const engine of ["godot-4.4", "godot-4.5"]) {
      const members: { pack: string; sha: string }[] = [];
      for (let i = 0; i < 64; i++) {
        const pack = packId(i);
        const sha = await hex(`${pack}:${level}:${engine}`);
        releases[sha] = { pack, version: `${level}.0.0`, seq: level };
        members.push({ pack, sha });
      }
      const id = (await packSetId(
        members.map((m) => ({ packId: m.pack, releaseSha256: m.sha })),
      ))!;
      sets[id] = members.map((m) => m.sha);
      for (const platform of PLATFORMS)
        rows.push({
          contentApi: level,
          platform,
          engine,
          variant: {},
          set: id,
        });
    }
  const target = async (platform: string): Promise<FeedTarget> => ({
    platform,
    release: {
      sha256: await hex(`app:${platform}`),
      seq: 15,
      version: "1.5.0",
    },
    floor: null,
    critical: false,
    outlets: {
      direct: {
        kind: "direct",
        live: { version: "1.5.0", seq: 15 },
        halted: false,
      },
      steam: {
        kind: "steam",
        live: { version: "1.5.0", seq: 15 },
        halted: false,
      },
    },
  });
  const revocations = [];
  const referenced = new Set<string>();
  for (let i = 0; i < 64; i++) {
    const record = await hex(`rev:${i}`);
    referenced.add(record);
    revocations.push({
      record,
      pack: packId(i),
      target: await hex(`target:${i}`),
      version: "2.9.9",
      seq: 9,
    });
  }
  return {
    channel: "stable",
    versionScheme: "semver",
    targets: await Promise.all(PLATFORMS.map(target)),
    content: {
      packSets: { releases, sets, rows },
      packFloors: Array.from({ length: 64 * 3 }, (_, i) => ({
        pack: packId(i % 64),
        contentApi: 3 + Math.floor(i / 64),
        minVersion: "3.0.1",
        versionScheme: "semver",
      })),
      revocations,
      referenced,
      audits: [],
    },
  };
}

describe("feed content on workerd (P4-13)", () => {
  it("fits, checks and signs the worst-case content for every platform within the CPU budget", async () => {
    const c = await worstCase();
    const t0 = Date.now();
    for (const platform of PLATFORMS) {
      const d = documentFor("djdl", c, platform, 7, 1_700_000_000);
      expect(feedSelfCheck(d.doc, d.platform), platform).toBe(true);
      expect(d.doc.app.targets).toEqual(
        c.targets.filter((t) => t.platform === platform),
      );
    }
    // workerd's clock advances only across I/O, so this bounds the whole loop loosely; the
    // real budget is the isolate's CPU limit, which a runaway loop here would exceed.
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("P4-19: a delegation's revocation (kind delegation) is kept and passes the self-check inside the isolate", async () => {
    const c = await worstCase();
    const revocations = [...(c.content.revocations ?? [])];
    revocations[0] = { ...revocations[0]!, kind: "delegation" as const };
    const d = documentFor(
      "djdl",
      { ...c, content: { ...c.content, packSets: null, revocations } },
      "web",
      7,
      1_700_000_000,
    );
    expect(feedSelfCheck(d.doc, d.platform)).toBe(true);
    const listed = d.doc.revocations as { kind?: string }[] | undefined;
    expect(listed?.some((r) => r.kind === "delegation")).toBe(true);
  });
});
