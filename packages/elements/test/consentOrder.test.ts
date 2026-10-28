// UXR-kits-v7 M2: the confirm and ask lines read in the model's order, not by key name.

import type { View } from "@polaris-key/ui-core";
import { describe, expect, it } from "vitest";

import { placeKeys } from "../src/contract.js";
import { LAYOUTS } from "../src/layout.js";

const view = (component: View["component"], copy: string[]): View =>
  ({
    component,
    state: "x",
    copy,
    args: {},
    actions: [],
    decisions: { primary: null },
  }) as unknown as View;

describe("body order", () => {
  it("SignIn/confirm: who, the license lines, then what the app also gets", () => {
    const copy = [
      "signin.auto.confirm.title",
      "signin.auto.confirm.as",
      "signin.consent.license",
      "signin.consent.newLicense",
      "signin.consent.alsoGets",
      "signin.consent.profile",
      "signin.consent.pairwise",
      "signin.auto.confirm.primary",
    ];
    const { body } = placeKeys(view("SignIn", copy), LAYOUTS.SignIn);
    expect(body).toEqual(copy.slice(1, 7));
  });

  it("NearbyApproval/ask: the instruction, then the warning", () => {
    const { body } = placeKeys(
      view("NearbyApproval", [
        "signin.nearby.ask",
        "signin.approve.warning",
        "signin.nearby.askBody",
        "signin.approve.deny",
      ]),
      LAYOUTS.NearbyApproval,
    );
    expect(body).toEqual(["signin.nearby.askBody", "signin.approve.warning"]);
  });
});
