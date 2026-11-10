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
  worstVersion: failures ? "4.2.2" : null,
});
const ctx = { godot: false, access: "public" };
const on = (...outlets: ReturnType<typeof out>[]) => ({
  counting: true,
  outlets,
});

describe("the Updates read model (P2-11)", () => {
  it("a Windows-only product sees no Sparkle, and no Godot updater unless it is a Godot game", () => {
    const v = updatersView([p("windows")], on(out("direct", 0)), ctx);
    expect(v.groups[0]!.platforms[0]!.updaters).toEqual([
      "winsparkle",
      "velopack",
      "app-installer",
    ]);
    const g = updatersView([p("windows")], on(out("direct", 0)), {
      ...ctx,
      godot: true,
    });
    expect(g.groups[0]!.platforms[0]!.updaters).toContain("godot");
  });

  it("desktop platforms on one outlet verify together, as one group", () => {
    const v = updatersView(
      [p("macos"), p("windows")],
      on(out("direct", 1)),
      ctx,
    );
    expect(v.groups).toHaveLength(1);
    expect(v.groups[0]!.state).toBe("verified");
    expect(v.groups[0]!.platforms.map((x) => x.platform)).toEqual([
      "macos",
      "windows",
    ]);
  });

  it("not seen until an outcome; an outlet of another kind does not verify", () => {
    expect(
      updatersView([p("macos")], on(out("direct", 0)), ctx).groups[0]!.state,
    ).toBe("not_seen");
    expect(
      updatersView([p("android")], on(out("direct", 5)), ctx).groups[0]!.state,
    ).toBe("not_seen");
  });

  it("failing names the release; no counters is unavailable", () => {
    const f = updatersView([p("macos")], on(out("direct", 3, 2)), ctx);
    expect(f.groups[0]).toMatchObject({
      state: "failing",
      reverted: 2,
      release: "4.2.2",
    });
    const u = updatersView(
      [p("macos")],
      { counting: false, outlets: [out("direct", 3)] },
      ctx,
    );
    expect(u.groups[0]!.state).toBe("unavailable");
  });

  it("a store-only platform is updated by the store, never Sparkle", () => {
    const v = updatersView(
      [p("macos"), p("ios")],
      on(out("app-store", 2)),
      ctx,
    );
    expect(v.groups).toEqual([]);
    expect(v.store).toEqual(["macos", "ios"]);
  });

  it("a planned-only platform, and the web, have no entry", () => {
    const v = updatersView(
      [p("linux", ["planned"] as never[]), p("web")],
      on(),
      ctx,
    );
    expect(v).toMatchObject({ groups: [], store: [] });
  });
});
