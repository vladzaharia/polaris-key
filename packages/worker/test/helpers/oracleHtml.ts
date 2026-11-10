// The route oracles compare what a route answers, not what a page says. An HTML response's body
// and length follow page copy. The oracles record that the route answered HTML, with its status
// and its other headers, the Content-Security-Policy included (less its build-derived hashes).
import { createHash } from "node:crypto";

/** Headers an HTML response does not record: its length follows copy. */
const BUILD_DERIVED = new Set(["content-length"]);

export function isHtml(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").startsWith("text/html");
}

/**
 * The header the oracle records: none for an HTML response's build-derived ones. Its CSP is kept,
 * so a weakened or missing policy still fails, with the script and style hashes (which follow the
 * built docs and admin shells; `docsCspParity` and `adminCspParity` own them) left out.
 */
export function recordedHeader(res: Response, name: string): string | null {
  if (BUILD_DERIVED.has(name) && isHtml(res)) return null;
  const v = res.headers.get(name);
  return v !== null && name === "content-security-policy" && isHtml(res)
    ? v.replace(/'sha(?:256|384|512)-[^']+'/g, "'sha-<hash>'")
    : v;
}

/** The body the oracle records: the length and a digest of the text, or `html`. */
export function recordedBody(res: Response, text: string): string {
  return isHtml(res)
    ? "html"
    : `${text.length}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}
