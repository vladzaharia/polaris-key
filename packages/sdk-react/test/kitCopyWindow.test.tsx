// @pkey-feature ui.kit
//
// A missing English key is tolerated only while English's second table is loading and the key is
// under a lazy prefix (`LAZY_EN_PREFIXES`): the view draws nothing until it arrives. After the
// table loaded, or for any other key, a missing key is not swallowed.

import { describe, expect, it, vi } from "vitest";
import { Copy, viewOf } from "@polaris-key/ui-core";

const view = (key: string) => ({
  ...viewOf("SignIn", { signIn: { methods: [] } } as never),
  state: "choose",
  copy: [key],
});
const ctx = (v: unknown, copy: Copy) =>
  ({ view: v, copy, resolved: {}, input: {} }) as never;

describe("the kit's copy window", () => {
  it("draws nothing while the rest table loads and the key is lazy", async () => {
    vi.resetModules();
    const kit = await import("../src/kit/contract.js");
    const { renderView } = await import("../src/kit/views.js");
    kit.copyFor("en"); // starts the load of the second table
    expect(kit.copyPending("signin.choice.title")).toBe(true);
    const c = new Copy({ tables: { en: {} } });
    expect(renderView(ctx(view("signin.choice.title"), c))).toBeNull();
  });

  it("does not swallow a lazy key once the full table has loaded, nor any other key", async () => {
    vi.resetModules();
    const kit = await import("../src/kit/contract.js");
    const { renderView } = await import("../src/kit/views.js");
    kit.provideTable("en", {});
    expect(kit.copyPending("signin.choice.title")).toBe(false);
    const c = new Copy({ tables: { en: {} } });
    expect(() => renderView(ctx(view("signin.choice.title"), c))).toThrow();
    expect(() => renderView(ctx(view("signin.nope"), c))).toThrow();
  });
});
