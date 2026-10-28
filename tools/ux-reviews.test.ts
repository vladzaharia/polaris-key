/**
 * UK-63: the UX review ledger is complete. `check.mjs --set <id> done` already refuses a UX-gated
 * package that builds a screen with no passing review in `ux-reviews.json`; this keeps the ledger
 * honest after the fact: every done package whose brief carries the pkey-ux-reviewer gate and
 * which owns (or overlays) a screen, hosted page or kit board in `ux-coverage.json` has a pass.
 * Packages closed with `--no-ux-gate` before this guard are `NO_REVIEW_DEBT`, each with the
 * reason; the list only shrinks (an entry whose package has since passed fails).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROGRAM = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs/research/2026-09-29-godot-omniplatform/program",
);
const json = <T>(f: string): T =>
  JSON.parse(readFileSync(join(PROGRAM, f), "utf8")) as T;

interface Wp {
  id: string;
  status: string;
  brief?: string;
}
interface Item {
  kind: string;
  owners: string[];
  overlays?: string[];
}

const NO_REVIEW_DEBT: Record<string, string> = {
  "UK-02b": "closed with --no-ux-gate before the ledger guard; review owed",
  "UK-03": "closed with --no-ux-gate before the ledger guard; review owed",
  "UK-49": "closed with --no-ux-gate before the ledger guard; review owed",
  "UK-56": "closed with --no-ux-gate before the ledger guard; review owed",
  "UK-59": "owner waived its review (2026-10-21); review owed",
};

const packages = json<{ workPackages: Wp[] }>("workpackages.json").workPackages;
const items = json<{ items: Item[] }>("ux-coverage.json").items;
const reviews = json<{ reviews: Record<string, { verdict: string }> }>(
  "ux-reviews.json",
).reviews;

const hasUxGate = (w: Wp) => {
  const f = join(PROGRAM, w.brief ?? "");
  return (
    !!w.brief &&
    existsSync(f) &&
    readFileSync(f, "utf8").includes("pkey-ux-reviewer")
  );
};
const ownsScreen = (id: string) =>
  items.some(
    (it) =>
      ["screen", "hosted", "kit-board"].includes(it.kind) &&
      (it.owners.includes(id) || (it.overlays ?? []).includes(id)),
  );
const unreviewed = packages
  .filter(
    (w) =>
      w.status === "done" &&
      hasUxGate(w) &&
      ownsScreen(w.id) &&
      reviews[w.id]?.verdict !== "pass",
  )
  .map((w) => w.id);

describe("ux-reviews.json (UK-63)", () => {
  it("records a pass for every done package that owns a screen", () => {
    expect(unreviewed.filter((id) => !(id in NO_REVIEW_DEBT))).toEqual([]);
  });

  it("holds no debt for a package that has since passed", () => {
    expect(
      Object.keys(NO_REVIEW_DEBT).filter((id) => !unreviewed.includes(id)),
    ).toEqual([]);
  });
});
