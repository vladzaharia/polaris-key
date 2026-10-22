/**
 * `/docs/help/codes.json`: every message id the Help messages know, for the search dialog's code
 * jump (`/docs/help/code/<id>/`, src/components/search.ts). Under `help/`, so it is public and the
 * customer host serves it with Help.
 */
import { HELP_MESSAGES } from "../../lib/helpMessages";

export function GET(): Response {
  const ids = [
    ...Object.keys(HELP_MESSAGES.messages),
    ...HELP_MESSAGES.developerOnly,
  ].sort();
  return new Response(JSON.stringify(ids), {
    headers: { "content-type": "application/json" },
  });
}
