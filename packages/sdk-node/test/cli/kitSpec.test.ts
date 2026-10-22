// @pkey-feature ui.cli
// The terminal kit against UI-KITS DL6 and DL7, read from the recorded goldens (the ANSI text).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const golden = (name: string): string =>
  readFileSync(new URL(`./golden/ansi/${name}.ansi`, import.meta.url), "utf8")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");

describe("the terminal kit against UI-KITS DL6 and DL7", () => {
  it.each([
    "status-screen-version-too-new",
    "status-screen-channel-not-entitled",
    "gate-refused-version-too-new",
    "gate-refused-not-entitled",
  ])("%s: a refusal no command fixes labels the product page", (name) => {
    const text = golden(name);
    expect(text).toContain("▲");
    expect(text).not.toContain("✗");
    expect(text).toMatch(/Next step on the .* page:\n│? ? ?.*polaris\.locker/);
  });

  it("a withdrawn required content is a triangle with its fix command", () => {
    const text = golden("update-prompt-revoked-required-content");
    expect(text).toContain("▲");
    expect(text).not.toContain("✗");
    expect(text).toContain("tidewater update apply");
  });

  it("cancelling a sign-in is not an error: no cross, no screen", () => {
    const text = golden("sign-in-handoff-cancelled");
    expect(text).not.toContain("✗");
    expect(text).toContain("Nothing changed.");
    expect(text).not.toContain("Sign in again");
  });

  it("an expired or denied sign-in keeps its way to start again", () => {
    for (const name of ["sign-in-handoff-expired", "sign-in-handoff-denied"])
      expect(golden(name)).toContain("Sign in again");
  });
});
