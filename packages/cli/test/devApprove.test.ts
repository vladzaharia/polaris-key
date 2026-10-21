// The dev-approve script's page parsers against both generations of the Worker's device pages:
// I-38a's confirmation (`<span class="code">`) and I-37's approval page and done title.

import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no types
import * as approve from "../scripts/dev-approve.mjs";

describe("dev-approve parsers", () => {
  it("reads the shown code in both markups", () => {
    expect(
      approve.readShownCode('<dl><dd class="code">ABCD-EFGH</dd></dl>'),
    ).toBe("ABCD-EFGH");
    expect(
      approve.readShownCode(
        '<p>It showed the code <span class="code">ABCD-EFGH</span>. Expires 14:32 UTC.</p>',
      ),
    ).toBe("ABCD-EFGH");
    expect(approve.readShownCode("<p>nothing</p>")).toBeUndefined();
  });

  it("finds the I-37 approval form", () => {
    const html =
      '<form method="post" action="/p/identity/auth/device/approve"><input type="hidden" name="token" value="tok">' +
      '<button class="button" type="submit" name="decision" value="approve"><span>Sign in</span></button>' +
      '<button type="submit" name="decision" value="deny">Deny</button></form>';
    const form = approve.readApprovalForm(html);
    expect(form.action).toBe("/p/identity/auth/device/approve");
    expect(form.fields).toEqual([["token", "tok"]]);
    expect(approve.readApprovalForm("<form method=post></form>")).toBe(
      undefined,
    );
  });

  it("accepts both done-page titles", () => {
    expect(
      approve.isSignedInPage(
        "<title>Signed in on Pixel · Polaris Locker</title>",
      ),
    ).toBe(true);
    expect(
      approve.isSignedInPage(
        "<title>Tidewater is signed in · Polaris Locker</title>",
      ),
    ).toBe(true);
    expect(approve.isSignedInPage("<title>Sign in on Pixel?</title>")).toBe(
      false,
    );
  });
});
