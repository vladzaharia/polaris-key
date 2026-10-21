// @pkey-feature ui.kit
//
// DL9's one focus-on-mount rule for the web kits (bug package H2, B-134): the elements and React
// both call it, so a Welcome screen focuses the same thing in both.

import { describe, expect, it } from "vitest";

import { focusOnMount, type MountFocusEnv } from "../src/index.js";

const env = (over: Partial<MountFocusEnv> = {}): MountFocusEnv => ({
  owns: true,
  asked: false,
  within: false,
  coldStart: false,
  coarse: false,
  targetIsField: false,
  ...over,
});

describe("focusOnMount", () => {
  it("never moves focus when the view asks for none", () => {
    expect(focusOnMount(null, env({ asked: true }))).toBe("none");
  });
  it("leaves a pane, strip or toast alone: only a screen or dialog takes focus", () => {
    expect(
      focusOnMount("welcome.signIn", env({ owns: false, asked: true })),
    ).toBe("none");
  });
  it("needs a reason: asked, already inside, or a window-filling cold start", () => {
    expect(focusOnMount("welcome.signIn", env())).toBe("none");
    expect(focusOnMount("welcome.signIn", env({ asked: true }))).toBe("target");
    expect(focusOnMount("welcome.signIn", env({ within: true }))).toBe(
      "target",
    );
    expect(focusOnMount("welcome.signIn", env({ coldStart: true }))).toBe(
      "target",
    );
  });
  it("gives a text field's turn to the heading under a coarse pointer", () => {
    expect(
      focusOnMount(
        "part.keyField.label",
        env({ asked: true, coarse: true, targetIsField: true }),
      ),
    ).toBe("heading");
    expect(
      focusOnMount("welcome.signIn", env({ asked: true, coarse: true })),
    ).toBe("target");
  });
  it("takes the heading when that is what the view names", () => {
    expect(focusOnMount("heading", env({ asked: true }))).toBe("heading");
  });
});
