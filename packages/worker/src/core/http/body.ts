/**
 * The one strict JSON-object body reader for the console and the portal. Empty bodies are `{}`;
 * oversized, malformed or non-object bodies throw {@link AdminBodyError} (413/400), which each
 * dispatcher catches once and answers in its own error shape. Never a silent `{}`.
 */

import { BodyTooLargeError, readBodyText } from "../cappedBody.js";

export class AdminBodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const MAX_ADMIN_BODY_BYTES = 64 * 1024;

/** Parse a JSON request body into an object. Empty bodies remain `{}`; malformed or
 *  oversized bodies are request errors, not silent empty objects. */
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readBodyText(req, MAX_ADMIN_BODY_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError)
      throw new AdminBodyError(413, "body_too_large", "request body too large");
    throw e;
  }
  if (raw.trim().length === 0) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw) as unknown;
  } catch {
    throw new AdminBodyError(
      400,
      "invalid_json",
      "request body is not valid JSON",
    );
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new AdminBodyError(
      400,
      "invalid_json",
      "request body must be a JSON object",
    );
  }
  return v as Record<string, unknown>;
}
