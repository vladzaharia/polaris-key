import { describe, expect, it } from "vitest";
import { brandPageResponse } from "../../src/core/brandPage.js";

const page = { title: "T", heading: "H" };

describe("brandPageResponse app strip", () => {
  it("draws the icon and allows exactly its origin in img-src", async () => {
    const res = brandPageResponse(400, {
      ...page,
      app: {
        name: "Tide <b>",
        iconUrl: "https://img.example.com/p/a/h/96.webp",
      },
    });
    const html = await res.text();
    expect(html).toContain('<img src="https://img.example.com/p/a/h/96.webp"');
    expect(html).toContain("Tide &lt;b&gt;");
    expect(res.headers.get("content-security-policy")).toContain(
      "img-src 'self' data: https://img.example.com;",
    );
  });

  it("drops an icon the policy would refuse, keeping the name", async () => {
    const res = brandPageResponse(400, {
      ...page,
      app: { name: "Tide", iconUrl: "http://evil.example.com/x.png" },
    });
    const html = await res.text();
    expect(html).not.toContain("<img");
    expect(html).toContain("<strong><bdi>Tide</bdi></strong>");
    expect(res.headers.get("content-security-policy")).toContain(
      "img-src 'self' data:;",
    );
  });
});
