// The kit's one validating opener (UI-KITS DL14, UK-55 link-validation): only https, or
// loopback http for local sign-in, ever reaches a click; nothing else is shown, copied or opened.
import { describe, expect, it } from "vitest";
import { safeLink } from "../src/kit/links.js";

describe("safeLink: the kit's one validating opener", () => {
  it("passes https and loopback http", () => {
    expect(safeLink("https://key.plrs.im/device?code=ABCD")).toBe(
      "https://key.plrs.im/device?code=ABCD",
    );
    expect(safeLink("http://127.0.0.1:8787/cb")).toBe(
      "http://127.0.0.1:8787/cb",
    );
    expect(safeLink("http://localhost:8787/cb")).toBe(
      "http://localhost:8787/cb",
    );
  });

  it("refuses http beyond loopback, javascript:, data: and file: links", () => {
    for (const url of [
      "http://key.plrs.im/device",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "ftp://example.com/x",
      "//example.com/x",
      "https://user:pw@example.com/",
    ])
      expect(safeLink(url), url).toBeNull();
  });

  it("refuses a missing link", () => {
    for (const url of [undefined, null, ""]) expect(safeLink(url)).toBeNull();
  });
});
