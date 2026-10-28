import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { viewOf, type UiInput } from "@polaris-key/ui-core";
import type {
  LicenseChoice,
  LicenseChoiceView,
  SignInRequestView,
} from "@polaris-key/protocol/identity";
import {
  classifyChoice,
  headerModel,
  licenseParts,
  requestHandleFromUrl,
  rowModel,
  safeRedirect,
  thisDeviceTitle,
} from "../src/portal/model/signInRequest.js";

/**
 * PX-14a: the LicenseChoice rows of `ui-matrix.json` run against `portal/model`. Each row whose
 * state a `LicenseChoiceView` alone decides must classify the same way in the card's model as in
 * ui-core (the kits'): one decision, two renderers.
 */
const REPO = join(import.meta.dirname, "..", "..", "..");
const matrix = JSON.parse(
  readFileSync(join(REPO, "conformance/corpus/v2/ui-matrix.json"), "utf8"),
) as {
  vocabulary: { defaults: Record<string, unknown> };
  signIn: {
    name: string;
    input: Record<string, unknown> & {
      choices?: LicenseChoiceView;
      selected?: string;
    };
    expect: { component: string; state: string };
  }[];
};

function withDefaults(input: Record<string, unknown>): UiInput {
  const out: Record<string, unknown> = { ...input };
  for (const [k, v] of Object.entries(matrix.vocabulary.defaults)) {
    if (k === "capabilities")
      out[k] = {
        ...(v as object),
        ...((input[k] as object | undefined) ?? {}),
      };
    else if (!(k in input)) out[k] = v;
  }
  return out as UiInput;
}

const DECIDED_BY_VIEW = new Set([
  "many",
  "one",
  "current",
  "keep",
  "new",
  "create",
  "all-full",
  "mixed",
  "none-keys",
  "none-no-keys",
]);

const rows = matrix.signIn.filter(
  (r) =>
    r.expect.component === "LicenseChoice" &&
    r.input.choices &&
    DECIDED_BY_VIEW.has(r.expect.state) &&
    // The raced and replace states ride on the event, not the view.
    !(r.input.signIn as { raced?: boolean; event?: string }).raced &&
    (r.input.signIn as { event?: string }).event !== "open-replace" &&
    !(r.input as { loading?: boolean }).loading,
);

describe("LicenseChoice rows of ui-matrix.json against portal/model", () => {
  it("covers the rows", () => {
    expect(rows.length).toBeGreaterThan(15);
  });
  for (const r of rows) {
    it(r.name, () => {
      const view = r.input.choices!;
      const kit = viewOf("LicenseChoice", withDefaults(r.input)).state;
      const mine = classifyChoice(view, r.input.selected ?? view.preselected);
      expect(kit.startsWith("none") ? "none" : kit).toBe(mine);
    });
  }
});

const ROW: LicenseChoice = {
  id: "lic_1",
  tierName: "Pro",
  name: null,
  origin: "key",
  access: "seats",
  seats: { used: 2, limit: 3 },
  current: false,
  expiresAt: null,
  state: "free",
  replace: null,
  freeDeviceUrl: null,
};

describe("rows", () => {
  it("tell tier, devices, origin and term, and hide key counters beside a sign-in licence", () => {
    const m = rowModel(ROW, [ROW], { product: "Diceroll", developer: "Games" });
    expect(m).toMatchObject({
      title: "Diceroll",
      pill: "Pro",
      devices: "2 of 3 devices",
      meta: "Added with a key · Lifetime",
      selectable: true,
    });
    const signIn: LicenseChoice = {
      ...ROW,
      id: "lic_2",
      access: "account",
      origin: "signin",
    };
    expect(
      rowModel(ROW, [ROW, signIn], { product: "Diceroll", developer: "Games" })
        .devices,
    ).toBeNull();
    expect(
      rowModel(signIn, [ROW, signIn], {
        product: "Diceroll",
        developer: "Games",
      }).meta,
    ).toBe("Sign-in · Lifetime");
  });

  it("a full row is not selectable and offers Replace only where allowed", () => {
    const full: LicenseChoice = {
      ...ROW,
      state: "full",
      seats: { used: 3, limit: 3 },
      replace: { allowed: true, retryAfter: null },
    };
    const m = rowModel(full, [full], { product: "D", developer: "G" });
    expect(m).toMatchObject({
      selectable: false,
      tag: "full",
      canReplace: true,
    });
    expect(
      rowModel(
        {
          ...full,
          replace: { allowed: false, retryAfter: null },
          freeDeviceUrl: "/x",
        },
        [full],
        {
          product: "D",
          developer: "G",
        },
      ),
    ).toMatchObject({ canReplace: false, freeDeviceUrl: "/x" });
  });
});

const VIEW: SignInRequestView = {
  request: "rq_AAAAAAAAAAAAAAAAAAAAAA",
  client: {
    product: "diceroll",
    kind: "native",
    appName: "Diceroll",
    developerName: "Example Games",
    iconUrl: "/media/diceroll/icon",
    origins: [],
    services: { license: true, cloudSync: false },
    nameVerified: true,
  },
  deviceLabel: "Mara's Pixel 8",
  userCode: null,
  expiresAt: 0,
};

describe("header", () => {
  it("is the request's data: app, developer, where", () => {
    expect(headerModel(VIEW)).toMatchObject({
      variant: "app",
      name: "Diceroll",
      developer: "Example Games",
      // A phone's label gets the phone glyph, not a monitor (LF1).
      where: { glyph: "phone", text: "on Mara's Pixel 8" },
      code: null,
    });
    expect(
      headerModel({ ...VIEW, deviceLabel: "Studio PC" }).where,
    ).toMatchObject({ glyph: "device" });
    expect(
      headerModel({
        ...VIEW,
        client: {
          ...VIEW.client,
          kind: "web",
          origins: ["https://dice.example"],
        },
      }).where,
    ).toEqual({ glyph: "globe", text: "dice.example" });
    expect(
      headerModel({
        ...VIEW,
        client: { ...VIEW.client, kind: "device" },
        userCode: "WDJB-MJHT",
      }),
    ).toMatchObject({
      variant: "device",
      code: "WDJB-MJHT",
      where: { glyph: "tv" },
    });
  });

  it("an unverified name draws no developer", () => {
    expect(
      headerModel({ ...VIEW, client: { ...VIEW.client, nameVerified: false } }),
    ).toMatchObject({ verified: false, developer: null });
  });
});

describe("consent line", () => {
  const ctx = { product: "Diceroll", app: "Diceroll", device: "this phone" };
  it("is a name over a meta line: the seat, the replaced device, the new licence", () => {
    expect(
      licenseParts({ kind: "license", row: ROW, replace: null }, ctx),
    ).toEqual({
      title: "Diceroll Pro",
      meta: "Lifetime · this phone becomes device 3 of 3",
    });
    expect(
      licenseParts(
        {
          kind: "license",
          row: ROW,
          replace: {
            id: "d",
            label: "Work laptop",
            meta: "",
            activeNow: false,
            thisBrowser: false,
            leastRecent: false,
            kind: "computer",
          },
        },
        ctx,
      ),
    ).toEqual({ title: "Diceroll Pro", meta: "replaces Work laptop" });
    expect(licenseParts({ kind: "new", tierName: "Free" }, ctx)?.title).toBe(
      "New: Free license, created when you continue",
    );
    expect(licenseParts({ kind: "none" }, ctx)).toBeNull();
  });
});

describe("addresses", () => {
  it("reads only a well-formed request handle", () => {
    expect(requestHandleFromUrl("?request=rq_AAAAAAAAAAAAAAAAAAAAAA")).toBe(
      "rq_AAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(requestHandleFromUrl("?request=nope")).toBeNull();
    expect(requestHandleFromUrl("?appName=Evil")).toBeNull();
  });
  it("never navigates to a script", () => {
    expect(safeRedirect("javascript:alert(1)")).toBeNull();
    expect(safeRedirect("https://app.example/cb?code=1")).toBe(
      "https://app.example/cb?code=1",
    );
    expect(safeRedirect("diceroll://cb?code=1")).toBe("diceroll://cb?code=1");
  });
});

describe("this device at a sentence start", () => {
  it("says This browser, and leaves a device label exactly as it is", () => {
    const v = (deviceLabel: string | null): SignInRequestView =>
      ({ deviceLabel }) as SignInRequestView;
    expect(thisDeviceTitle(v(null))).toBe("This browser");
    expect(thisDeviceTitle(v("Steam Deck"))).toBe("Steam Deck");
    expect(thisDeviceTitle(v("iPhone 15 Pro"))).toBe("iPhone 15 Pro");
  });
});
