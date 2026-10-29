/** A-22.7: which channel an outlet's entry points open (the Worker's `subkindOf`, mirrored). */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  OutletKindLine,
  outletRowActions,
} from "../src/console/sections/distribution/components/OutletKindLine.js";
import { channelOfOutlet } from "../src/console/sections/distribution/model/subkind.js";

const o = (kind: string, identity?: Record<string, unknown>) => ({
  outletId: "x",
  kind,
  identity: identity ?? {},
});

describe("an outlet's channel", () => {
  it("a bare direct outlet is Polaris Locker", () => {
    expect(channelOfOutlet(o("direct"))?.id).toBe("polaris-key");
  });
  it("a cask or formula is Homebrew", () => {
    expect(channelOfOutlet(o("direct", { homebrewCask: "djdl" }))?.id).toBe(
      "homebrew",
    );
    expect(channelOfOutlet(o("direct", { homebrewFormula: "djdl" }))?.id).toBe(
      "homebrew",
    );
  });
  it("an explicit subkind wins (Scoop)", () => {
    expect(channelOfOutlet(o("direct", { subkind: "scoop" }))?.id).toBe(
      "scoop",
    );
  });
  it("a direct outlet with no identity read has no channel link", () => {
    expect(channelOfOutlet({ kind: "direct" })).toBeNull();
    expect(channelOfOutlet({ kind: "app-store" })?.id).toBe("app-store");
  });
});

describe("the entry points", () => {
  it("the row menu names the real channel", () => {
    const labels = outletRowActions(
      "djdl",
      o("direct", { homebrewCask: "d" }),
    ).map((a) => ("label" in a ? a.label : ""));
    expect(labels).toEqual(["Open details", "Open Homebrew channel"]);
  });
  it("the subtitle puts the track before the link, and omits an unknown direct one", () => {
    const { container } = render(
      <OutletKindLine
        slug="djdl"
        outlet={{ kind: "app-store" }}
        track="stable"
      />,
    );
    expect(container.textContent).toMatch(/· stable · Open App Store channel$/);
    render(<OutletKindLine slug="djdl" outlet={{ kind: "direct" }} />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});
