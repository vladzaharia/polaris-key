import { beforeEach, describe, expect, it } from "vitest";
import { consumeStepUpReturn, markStepUpLeave } from "../src/portal/focus.js";

const plain = {
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
};

describe("the step-up return flag", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("is read once, after a plain click", () => {
    markStepUpLeave(plain);
    expect(consumeStepUpReturn()).toBe(true);
    expect(consumeStepUpReturn()).toBe(false);
  });

  it("is not set by a new-tab click or a non-primary button", () => {
    markStepUpLeave({ ...plain, ctrlKey: true });
    markStepUpLeave({ ...plain, metaKey: true });
    markStepUpLeave({ ...plain, button: 1 });
    expect(consumeStepUpReturn()).toBe(false);
  });

  it("goes stale after ten minutes", () => {
    markStepUpLeave(plain);
    expect(consumeStepUpReturn(Date.now() + 11 * 60 * 1000)).toBe(false);
    expect(consumeStepUpReturn()).toBe(false);
  });
});
