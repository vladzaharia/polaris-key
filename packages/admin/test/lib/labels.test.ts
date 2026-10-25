import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findChannel } from "@polaris-key/manifest";
import { OUTLET_SUBKINDS } from "@polaris-key/protocol/distribution";
import {
  ACCESS_DESCRIPTIONS,
  ACCESS_LABELS,
  outletKindName,
  outletLabel,
  outletSubkindLabel,
  PROVIDER_LABELS,
  REGISTRATION_LABELS,
  SIGN_IN_LABELS,
  label,
} from "../../src/lib/labels.js";

describe("labels (ADMIN.md §5.8)", () => {
  it("words the documented examples", () => {
    expect(label(REGISTRATION_LABELS, "requires-license")).toBe(
      "License required",
    );
    expect(label(SIGN_IN_LABELS, "manual")).toBe("Manual");
    expect(label(SIGN_IN_LABELS, "oidc")).toBe("Single sign-on");
    expect(label(PROVIDER_LABELS, "github")).toBe("GitHub");
    expect(label(PROVIDER_LABELS, null)).toBe("None");
    expect(label(PROVIDER_LABELS, undefined)).toBe("None");
  });

  it("humanises an unknown value rather than showing the slug", () => {
    expect(label(ACCESS_LABELS, "staff-only")).toBe("Staff only");
  });

  it("describes every access mode", () => {
    expect(Object.keys(ACCESS_DESCRIPTIONS).sort()).toEqual(
      Object.keys(ACCESS_LABELS).sort(),
    );
  });
});

describe("the direct outlet reads Polaris Locker (S-21 §6.8)", () => {
  it("labels the kind and its subkinds, keeping the id direct", () => {
    expect(outletKindName("direct")).toBe("Polaris Locker");
    expect(outletLabel("direct")).toBe("Polaris Locker");
    expect(outletLabel("direct", "homebrew")).toBe(
      "Polaris Locker · via Homebrew",
    );
    expect(outletLabel("direct", "appimage")).toBe(
      "Polaris Locker · via AppImage",
    );
    expect(outletLabel("direct", null)).toBe("Polaris Locker");
    expect(outletLabel("steam")).toBe("Steam");
  });

  it("labels every protocol subkind", () => {
    const names = OUTLET_SUBKINDS.map(outletSubkindLabel);
    expect(names).toContain("Homebrew");
    expect(names).toContain("Scoop");
    expect(names).toContain("AppImage");
    for (const s of OUTLET_SUBKINDS) {
      // a catalogue channel reads its catalogue label; the rest come from the local table
      expect(outletSubkindLabel(s), s).toBe(
        findChannel(s)?.label ?? outletSubkindLabel(s),
      );
      expect(outletSubkindLabel(s), s).not.toBe("");
    }
  });

  it("no console source says Direct download", () => {
    const root = join(import.meta.dirname, "../../src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(tsx?|html|css)$/.test(name)) {
          if (/direct download/i.test(readFileSync(path, "utf8")))
            offenders.push(path.slice(root.length + 1));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
