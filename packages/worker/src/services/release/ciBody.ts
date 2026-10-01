/// <reference types="@cloudflare/workers-types" />

/**
 * The JSON body of a CI route (P2-05's policy routes, P2-02's publish routes): one object, under
 * a byte cap the route chooses. Declared and actual length are both checked, so a lying
 * `Content-Length` cannot stretch the read.
 */

import { errorResponse, ErrorCode } from "../../core/errors.js";

export async function readCiJson(
  req: Request,
  maxBytes: number,
): Promise<Record<string, unknown> | Response> {
  const bad = (message: string) =>
    errorResponse(400, ErrorCode.BadRequest, message, { reason: "bad_body" });
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes)
    return bad("request body too large");
  const raw = await req.text();
  if (raw.length > maxBytes) return bad("request body too large");
  if (raw.trim() === "") return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v))
      return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return bad("request body must be a JSON object");
}
