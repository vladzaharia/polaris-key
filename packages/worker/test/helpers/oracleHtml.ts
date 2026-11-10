// The route oracles compare what a route answers, not what a page says. An HTML response's body
// follows page copy and its Content-Security-Policy follows the built docs and admin shells'
// script and style hashes; `docsCspParity`, `adminCspParity` and `brandPages` own those. The
// oracles record that the route answered HTML, with its status and its other headers.

/** Headers an HTML response does not record: its length follows copy, its CSP follows the build. */
const BUILD_DERIVED = new Set(["content-security-policy", "content-length"]);

export function isHtml(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").startsWith("text/html");
}

/** Whether the oracle leaves `name` out of an HTML response's row. */
export function skipForHtml(res: Response, name: string): boolean {
  return BUILD_DERIVED.has(name) && isHtml(res);
}
