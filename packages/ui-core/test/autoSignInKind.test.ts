// The web feed names the confirm line's kind only for the four exchange kinds (as Godot and Kotlin do).

import { describe, expect, it } from "vitest";

import { outcomeOf } from "../src/browser/sdk/autoSignIn.js";

const confirm = (provider?: string) =>
  outcomeOf({
    kind: "confirm",
    grant: "sg_x",
    expiresIn: 300,
    consent: {
      client: { appName: "App", nameVerified: true },
      as: provider ? { provider } : {},
      items: [],
      scopeHash: "h",
      firstTime: false,
      changed: false,
    },
  } as never);

describe("outcomeOf: the confirm kind", () => {
  it.each(["apple", "google", "gamecenter", "pgs"])("keeps %s", (kind) => {
    expect(confirm(kind)).toMatchObject({ input: { kind } });
  });
  it.each(["github", "", undefined])("drops %s", (kind) => {
    const out = confirm(kind) as { input: Record<string, unknown> };
    expect("kind" in out.input).toBe(false);
  });
});
