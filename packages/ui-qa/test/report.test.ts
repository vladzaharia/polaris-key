// The side-by-side report lines the kits up by state (UI-KITS.md §7.1). Every kit's baseline
// state names one registry row (packages/brand/kit-copy/components.json), however the kit spells
// it, or is listed in rules/kit-only-states.json as the kit's own.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalOf, canonicalStates, collect } from "../src/report.ts";

const allow = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../rules/kit-only-states.json"),
    "utf8",
  ),
) as Record<string, { reason: string; states: string[] } | string>;
const entries = Object.entries(allow).filter(
  (e): e is [string, { reason: string; states: string[] }] =>
    typeof e[1] !== "string",
);

describe("state ids across the kits", () => {
  const canon = canonicalStates();
  const report = collect();
  const kitShots = report.shots.filter((s) => !s.source.startsWith("mockup:"));
  const registry = new Set(canon.values());

  it("maps each kit's spelling onto the registry id", () => {
    for (const raw of [
      "Welcome.default",
      "welcome-default",
      "welcomedefault",
      "accountAndLicense-key-only",
      "polariskeygate-needs-activation.macos",
      "update-prompt-platform-npm",
    ])
      expect(canonicalOf(canon, raw), raw).not.toBeNull();
    expect(canonicalOf(canon, "Welcome.default")).toBe("welcome-default");
    expect(canonicalOf(canon, "accountAndLicense-key-only")).toBe(
      "account-and-license-key-only",
    );
  });

  it("puts React beside another kit for a state they both draw", () => {
    const react = new Set(
      kitShots.filter((s) => s.source === "react").map((s) => s.state),
    );
    const shared = [...react].filter((state) =>
      kitShots.some((s) => s.source !== "react" && s.state === state),
    );
    expect(shared.length).toBeGreaterThan(40);
  });

  it("leaves no kit state without a counterpart unless it is listed as the kit's own", () => {
    const unmatched = new Map<string, Set<string>>();
    for (const s of kitShots)
      if (!registry.has(s.state)) {
        const set = unmatched.get(s.source) ?? new Set<string>();
        unmatched.set(s.source, set);
        set.add(s.state);
      }
    const listed = new Map(entries.map(([kit, e]) => [kit, new Set(e.states)]));
    const missing: string[] = [];
    for (const [kit, states] of unmatched)
      for (const state of states)
        if (!listed.get(kit)?.has(state)) missing.push(`${kit}: ${state}`);
    expect(
      missing,
      "name these in the registry or kit-only-states.json",
    ).toEqual([]);
    // The list only shrinks: an entry whose state now matches, or is gone, goes.
    const stale: string[] = [];
    for (const [kit, states] of listed)
      for (const state of states)
        if (!unmatched.get(kit)?.has(state)) stale.push(`${kit}: ${state}`);
    expect(stale, "stale kit-only-states.json entries").toEqual([]);
    for (const [kit, e] of entries)
      expect(e.reason.length, `${kit} has a reason`).toBeGreaterThan(20);
  });
});
