// The route oracles compare what a route answers, not what a page says. An HTML response's body
// follows page copy and its Content-Security-Policy follows the built docs and admin shells'
// script and style hashes; `docsCspParity`, `adminCspParity` and `brandPages` own those. The
// oracles record that the route answered HTML, with its status and its other headers.
import { createHash } from "node:crypto";

/** Headers an HTML response does not record: its length follows copy, its CSP follows the build. */
const BUILD_DERIVED = new Set(["content-security-policy", "content-length"]);

export function isHtml(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").startsWith("text/html");
}

/** The header the oracle records: none for an HTML response's build-derived ones. */
export function recordedHeader(res: Response, name: string): string | null {
  return BUILD_DERIVED.has(name) && isHtml(res) ? null : res.headers.get(name);
}

/** The body the oracle records: the length and a digest of the text, or `html`. */
export function recordedBody(res: Response, text: string): string {
  return isHtml(res)
    ? "html"
    : `${text.length}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}
