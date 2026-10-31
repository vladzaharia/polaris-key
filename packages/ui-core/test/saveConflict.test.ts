// @pkey-feature ui.settings
//
// The save screens' models beyond the matrix rows (ui-matrix.json `saveConflict`, U-22.K): what no
// row can say alone. Keep both is drawn disabled, never absent, while no slot is free, and the
// host not saying so counts as none; a deletion has its own button; a view's strings, made text in
// every launch locale, show no raw `{name}`.

import { describe, expect, it } from "vitest";
import { loadKitCopy, KIT_COPY_LOCALES } from "@polaris-key/brand/kit-copy";

import { Copy, viewOf, type CopyTable, type UiInput } from "../src/index.js";
import { readMatrix, withDefaults, type Obj } from "./matrix.js";

const defaults = readMatrix().vocabulary.defaults;
const sc = (saveConflict: Obj): UiInput =>
  withDefaults({ saveConflict }, defaults);
const THIS = { when: "today, 14:02" };
const OTHER = { when: "yesterday, 21:40", device: "Maya's Steam Deck" };

describe("SaveConflict", () => {
  it("draws Keep both disabled with its reason when the host does not say a slot is free", () => {
    for (const bothAvailable of [false, undefined]) {
      const v = viewOf(
        "SaveConflict",
        sc({ step: "choose", local: THIS, remote: OTHER, bothAvailable }),
      );
      expect(v.copy).toContain("saveConflict.keepBoth");
      expect(v.copy).toContain("saveConflict.bothFull");
      expect(v.actions).not.toContain("keep-both");
      expect(v.actions).toContain("keep-local");
    }
  });

  it("offers Keep both only with a free slot, and never a reason then", () => {
    const v = viewOf(
      "SaveConflict",
      sc({ step: "choose", local: THIS, remote: OTHER, bothAvailable: true }),
    );
    expect(v.actions).toEqual([
      "cancel",
      "keep-both",
      "keep-local",
      "keep-remote",
    ]);
    expect(v.copy).not.toContain("saveConflict.bothFull");
  });

  it("takes no default: no filled control, and focus on the heading", () => {
    const v = viewOf(
      "SaveConflict",
      sc({ step: "choose", local: THIS, remote: OTHER, bothAvailable: true }),
    );
    expect(v.decisions.primary).toBeNull();
    expect(v.decisions.focus).toBe("heading");
  });

  it("gives a deleted copy its own button and no Keep both", () => {
    const v = viewOf(
      "SaveConflict",
      sc({ step: "choose", local: THIS, remote: null, bothAvailable: true }),
    );
    expect(v.copy).toContain("saveConflict.acceptDelete");
    expect(v.copy).not.toContain("saveConflict.keepOther");
    expect(v.copy).not.toContain("saveConflict.keepBoth");
    expect(v.actions).toEqual(["cancel", "keep-local", "keep-remote"]);
  });

  it("offers no control while a choice is applied, and names it once kept", () => {
    const keeping = viewOf(
      "SaveConflict",
      sc({ step: "keeping", keep: "both", local: THIS, remote: OTHER }),
    );
    expect(keeping.actions).toEqual([]);
    const kept = viewOf(
      "SaveConflict",
      sc({ step: "kept", keep: "both", local: THIS, remote: OTHER }),
    );
    expect(kept.copy).toContain("saveConflict.keptBoth");
    expect(kept.copy).not.toContain("saveConflict.keptLocal");
  });

  it("is hidden with Cloud Sync off, and with no conflict", () => {
    expect(viewOf("SaveConflict", withDefaults({}, defaults)).state).toBe(
      "hidden",
    );
    expect(
      viewOf("SaveConflict", {
        ...sc({ step: "choose" }),
        services: ["license"],
      } as UiInput).state,
    ).toBe("hidden");
  });
});

describe("CloudSyncStatus transfers", () => {
  const status = (cloudSync: Obj) =>
    viewOf("CloudSyncStatus", withDefaults({ cloudSync }, defaults));
  it("never says synced while a transfer is pending", () => {
    for (const state of ["transferring", "waiting", "transfer-failed"])
      expect(status({ state, lastSynced: "2 min ago" }).copy).not.toContain(
        "cloudSync.synced",
      );
  });
  it("shows the progress only when both sizes are known", () => {
    expect(
      status({ state: "transferring", transfer: { size: "38 MB" } }).copy,
    ).toEqual(["cloudSync.transferring"]);
  });
  it("names what a waiting transfer waits for", () => {
    expect(status({ state: "waiting" }).copy).toEqual([
      "cloudSync.waitingNetwork",
    ]);
    expect(status({ state: "waiting", reason: "battery" }).copy).toEqual([
      "cloudSync.waitingBattery",
    ]);
  });
});

describe("no raw placeholder in the save screens", () => {
  it("makes every string text in every launch locale", async () => {
    const tables: Record<string, CopyTable> = {};
    for (const l of KIT_COPY_LOCALES) tables[l] = await loadKitCopy(l);
    const rows = readMatrix().saveConflict as {
      input: Obj;
      expect: { component: string };
    }[];
    for (const locale of KIT_COPY_LOCALES) {
      const copy = new Copy({ tables: tables as { en: CopyTable }, locale });
      for (const r of rows) {
        const v = viewOf(
          r.expect.component as "SaveConflict",
          withDefaults(r.input, defaults),
        );
        for (const key of v.copy) {
          const text = copy.format(key, {
            ...v.args,
            ...(v.keyArgs?.[key] ?? {}),
          });
          expect(text, `${locale} ${key}`).not.toMatch(/\{[A-Za-z]+\}/);
        }
      }
    }
  });
});
