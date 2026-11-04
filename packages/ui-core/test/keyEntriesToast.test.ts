// @pkey-feature ui.gate ui.signin
//
// The "{left} key entries left" line as a catalog Toast: info, the line only, hidden when the
// License or Identity service is off or `left` is not a non-negative integer.

import { describe, expect, it } from "vitest";
import { KIT_COPY_EN } from "@polaris-key/brand/kit-copy";

import { Copy, viewOf, type UiInput } from "../src/index.js";

const en = new Copy({ tables: { en: KIT_COPY_EN } });
const toast = (left: unknown, extra: Partial<UiInput> = {}) =>
  viewOf("Toast", {
    toast: { kind: "key-entries", left: left as number },
    ...extra,
  });

describe("key-entries toast", () => {
  it("is an info toast carrying only the line", () => {
    const v = toast(2);
    expect(v.state).toBe("info");
    expect(v.copy).toEqual(["signin.key.entriesLeftShort"]);
    expect(v.args).toMatchObject({ left: 2 });
    expect(en.strings(v)["signin.key.entriesLeftShort"]).toBe(
      "2 key entries left",
    );
    expect(en.strings(toast(1))["signin.key.entriesLeftShort"]).toBe(
      "1 key entry left",
    );
    expect(toast(0).state).toBe("info");
  });

  it.each([undefined, -1, 1.5, Number.NaN, "2"])(
    "is hidden when left is %s",
    (left) => {
      expect(toast(left).state).toBe("hidden");
    },
  );
});
