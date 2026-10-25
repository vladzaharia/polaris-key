import { describe, expect, it } from "vitest";
import {
  STATUS,
  humanize,
  licenseState,
  statusOf,
} from "../../src/lib/status.js";

describe("status vocabulary (components.md §6.4)", () => {
  it("has every domain row", () => {
    expect(Object.keys(STATUS).sort()).toEqual(
      [
        "availability",
        "compat",
        "device",
        "edgeMint",
        "fingerprint",
        "key",
        "license",
        "purchase",
        "readiness",
        "rollout",
        "secret",
        "source",
        "storefront",
      ].sort(),
    );
  });

  it.each([
    ["license", "active", "Active", "success"],
    ["license", "expired", "Expired", "warning"],
    ["license", "disabled", "Disabled", "neutral"],
    ["key", "revoked", "Revoked", "neutral"],
    ["device", "authorized", "Authorized", "success"],
    ["fingerprint", "drifted", "Drifted", "warning"],
    ["rollout", "active", "Rolling out", "accent"],
    ["rollout", "paused", "Paused", "warning"],
    ["rollout", "halted", "Halted", "danger"],
    ["rollout", "complete", "Complete", "success"],
    ["availability", "approved", "Approved", "info"],
    ["availability", "in-review", "In review", "neutral"],
    ["availability", "rejected", "Rejected", "danger"],
    ["readiness", "holds", "Held", "warning"],
    ["readiness", "warning", "Not ready", "warning"],
    ["readiness", "ok", "Ready", "success"],
    ["compat", "pinned", "Pinned", "accent"],
    ["compat", "incompatible", "Incompatible", "danger"],
    ["compat", "current", "Current", "outline"],
    ["edgeMint", "pending", "Needs approval", "warning"],
    ["edgeMint", "changed", "Changed since approval", "warning"],
    ["secret", "missing", "Missing", "warning"],
    ["source", "manifest", "From manifest", "neutral"],
    ["source", "admin", "Set in console", "info"],
  ] as const)("%s %s → %s (%s)", (domain, state, label, tone) => {
    const e = statusOf(domain, state);
    expect(e.label).toBe(label);
    expect(e.tone).toBe(tone);
    expect(e.icon).toBeTruthy();
  });

  it("never blanks an unknown state", () => {
    expect(statusOf("rollout", "rolling_back")).toMatchObject({
      label: "Rolling back",
      tone: "neutral",
    });
    expect(humanize("")).toBe("Unknown");
  });

  it("edge mint pending and changed are distinct by icon and words (EMR-2)", () => {
    // Both stop minting, so both are warnings (CX-CFG review C9); the glyph and label tell them apart.
    expect(STATUS.edgeMint.pending.label).not.toBe(
      STATUS.edgeMint.changed.label,
    );
    expect(STATUS.edgeMint.pending.icon).not.toBe(STATUS.edgeMint.changed.icon);
  });

  it("computes license state from status and expiry (LIC-1)", () => {
    const now = Date.UTC(2026, 9, 1);
    const day = 86_400;
    const s = (n: number) => Math.floor(now / 1000) + n * day;
    expect(licenseState({ status: "active", expiresAt: null }, now).label).toBe(
      "Active",
    );
    expect(
      licenseState({ status: "active", expiresAt: s(400) }, now).label,
    ).toBe("Active");
    expect(
      licenseState({ status: "active", expiresAt: s(4) }, now),
    ).toMatchObject({ label: "Expires in 4 days", tone: "warning" });
    expect(licenseState({ status: "active", expiresAt: s(1) }, now).label).toBe(
      "Expires in 1 day",
    );
    expect(
      licenseState({ status: "active", expiresAt: s(-1) }, now).label,
    ).toBe("Expired");
    expect(
      licenseState({ status: "disabled", expiresAt: s(-1) }, now).label,
    ).toBe("Disabled");
  });
});
