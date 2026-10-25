import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs build script
import { inlineScripts } from "../scripts/inline-scripts.mjs";

const scripts = (html: string): string[] => inlineScripts(html);

describe("inlineScripts (the docs CSP collector)", () => {
  it("returns a real inline script and an import map, once each", () => {
    const html = `<head><script>var a=1;</script><script type="importmap">{"imports":{}}</script></head>`;
    expect(scripts(html)).toEqual(["var a=1;", '{"imports":{}}']);
  });

  it("skips src scripts and empty bodies", () => {
    expect(
      scripts(
        `<script src="/a.js"></script><script></script><script  SRC='/b.js'>x</script>`,
      ),
    ).toEqual([]);
  });

  it("ignores a raw <script> inside an attribute value", () => {
    const html = `<button data-code="<script>evil()</script>" title='<script>x</script>'>Copy</button><p>ok</p>`;
    expect(scripts(html)).toEqual([]);
  });

  it("ignores an entity-encoded <script> in an attribute and in <pre><code>", () => {
    const html = `<div data-code="&lt;script&gt;evil()&lt;/script&gt;"><pre><code>&lt;script&gt;evil()&lt;/script&gt;</code></pre></div>`;
    expect(scripts(html)).toEqual([]);
  });

  it("ignores a <script> in an HTML comment and in a textarea", () => {
    const html = `<!-- <script>evil()</script> --><textarea><script>evil()</script></textarea><script>real()</script>`;
    expect(scripts(html)).toEqual(["real()"]);
  });

  it("finds the real script after a decoy with a > inside an attribute", () => {
    const html = `<a data-x="a>b <script>evil()</script>">t</a><script>real()</script>`;
    expect(scripts(html)).toEqual(["real()"]);
  });

  it("takes the body verbatim up to the first closing tag", () => {
    expect(scripts(`<script>\n  a("</div>");\n</SCRIPT >`)).toEqual([
      `\n  a("</div>");\n`,
    ]);
  });
});
