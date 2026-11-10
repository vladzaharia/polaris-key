import { describe, expect, it } from "vitest";
import { updatersView } from "../src/console/lib/updaterModel.js";

const p = (platform: string, sources = ["builds"] as never[]) => ({
  platform,
  arches: ["x86_64"],
  formats: [],
  sources,
});
const out = (kind: string, checks: number, failures = 0) => ({
  outlet: kind,
  kind,
  checks,
  failures,
});

describe("the Updates read model (P2-11)", () => {
  it("a Windows-only product sees no Sparkle", () => {
    const v = updatersView([p("windows")], { counting: true, outlets: [] });
    expect(v.platforms.map((x) => x.platform)).toEqual(["windows"]);
    expect(v.platforms[0]!.updaters).not.toContain("sparkle");
    expect(v.platforms[0]!.updaters[0]).toBe("winsparkle");
  });

  it("Verified flips on the first reported outcome on a matching outlet", () => {
    const none = updatersView([p("macos")], {
      counting: true,
      outlets: [out("direct", 0)],
    });
    const one = updatersView([p("macos")], {
      counting: true,
      outlets: [out("direct", 1)],
    });
    expect(none.platforms[0]!.state).toBe("not_seen");
    expect(one.platforms[0]!.state).toBe("verified");
  });

  it("an outlet of another platform's kind does not verify it", () => {
    const v = updatersView([p("android")], {
      counting: true,
      outlets: [out("direct", 5)],
    });
    expect(v.platforms[0]!.state).toBe("not_seen");
  });

  it("failures are failing even when checks passed; no counters is unavailable", () => {
    const f = updatersView([p("macos")], {
      counting: true,
      outlets: [out("direct", 3, 2)],
    });
    expect(f.platforms[0]!.state).toBe("failing");
    const u = updatersView([p("macos")], {
      counting: false,
      outlets: [out("direct", 3)],
    });
    expect(u.platforms[0]!.state).toBe("unavailable");
  });

  it("a planned-only platform, and the web, have no card", () => {
    const v = updatersView([p("linux", ["planned"] as never[]), p("web")], {
      counting: true,
      outlets: [],
    });
    expect(v.platforms).toEqual([]);
  });
});
