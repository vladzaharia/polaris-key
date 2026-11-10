/**
 * The token endpoint's HTTP shapes, shared by the own client's grants and a registered client's
 * (I-21.9): a flat RFC 6749 §5.2 error that is never cached, and the form body read as single
 * values. A JSON body, an over-long body or a repeated parameter is no form at all.
 */

import { errorResponse } from "../../../core/errors.js";
import { readBodyText, BodyTooLargeError } from "../../../core/cappedBody.js";

/** The largest form body read. A code and a verifier are under 200 bytes. */
const MAX_FORM_BYTES = 4 * 1024;

export const oauth = (
  status: number,
  error: string,
  description?: string,
  extra?: Record<string, unknown>,
): Response =>
  withNoStore(
    errorResponse(status, error, undefined, {
      ...(description ? { error_description: description } : {}),
      ...(extra ?? {}),
    }),
  );

export function withNoStore(res: Response): Response {
  res.headers.set("cache-control", "no-store");
  res.headers.set("pragma", "no-cache");
  return res;
}

/** The form body as single-valued parameters, or `null` when it is not a plain form. */
export async function readForm(
  req: Request,
): Promise<Map<string, string> | null> {
  const type = (req.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return null;
  let raw: string;
  try {
    raw = await readBodyText(req, MAX_FORM_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return null;
    throw e;
  }
  const out = new Map<string, string>();
  for (const [k, v] of new URLSearchParams(raw)) {
    if (out.has(k)) return null; // a repeated parameter is refused (RFC 6749 §3.1)
    out.set(k, v);
  }
  return out;
}
