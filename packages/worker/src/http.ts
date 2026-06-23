/// <reference types="@cloudflare/workers-types" />

/** Stable error codes returned to clients (mirrors the SDK error taxonomy). */
export const ErrorCode = {
  Unauthorized: "unauthorized",
  NotEntitled: "not_entitled",
  MachineLimit: "machine_limit",
  BadRequest: "bad_request",
  NotFound: "not_found",
  ManagedByAdmin: "managed_by_admin",
  Forbidden: "forbidden",
} as const;

export function json(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...(init?.headers ?? {}) },
  });
}

export function errorResponse(
  status: number,
  code: string,
  message?: string,
  extra?: Record<string, unknown>,
): Response {
  return json({ error: code, ...(message ? { message } : {}), ...(extra ?? {}) }, { status });
}

export function notFound(): Response {
  return errorResponse(404, ErrorCode.NotFound);
}

export function methodNotAllowed(): Response {
  return new Response("Method Not Allowed", { status: 405 });
}

/** Extract a Bearer credential from the Authorization header. */
export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? (m[1] ?? null) : null;
}
