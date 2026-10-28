/**
 * Is this request a browser navigation (a person's click or typed address), as opposed to an API
 * or fetch call? `Sec-Fetch-Dest: document` / `Sec-Fetch-Mode: navigate` where the browser sends
 * them, else an `Accept` that names `text/html`. A fetch's wildcard `Accept` is not one, so
 * API callers keep their JSON answers (HA-09F).
 */
export function isBrowserNavigation(req: Request): boolean {
  const dest = req.headers.get("sec-fetch-dest");
  if (dest !== null) return dest === "document";
  if (req.headers.get("sec-fetch-mode") === "navigate") return true;
  return /\btext\/html\b/i.test(req.headers.get("accept") ?? "");
}
