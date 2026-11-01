/// <reference types="@cloudflare/workers-types" />
// One console API request through `handleAdmin`, signed in as a test session. Fake values only.
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { handleAdmin } from "../src/console/index.js";
import { ADMIN_COOKIE, CSRF_HEADER } from "../src/core/console/session.js";
import { consoleTestSession } from "./consoleSessionHelper.js";
import { NOW } from "./seed.js";

export interface AdminCall {
  method: string;
  body?: unknown;
  sub?: string;
  groups?: string[];
  csrf?: boolean;
}

export async function adminCall(
  env: Env,
  db: Db,
  path: string,
  o: AdminCall,
): Promise<{ status: number; body: Record<string, any>; text: string }> {
  const { token, session } = await consoleTestSession(
    env,
    db,
    {
      sub: o.sub ?? "admin-1",
      name: "A",
      email: "a@example.test",
      groups: o.groups ?? [
        (env as { PLATFORM_ADMIN_GROUP?: string }).PLATFORM_ADMIN_GROUP ?? "",
      ],
    },
    NOW,
  );
  const headers: Record<string, string> = {
    cookie: `${ADMIN_COOKIE}=${token}`,
  };
  if (o.csrf !== false) headers[CSRF_HEADER] = session.csrf;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res = await handleAdmin(
    new Request(`https://key.plrs.im/manage${path}`, {
      method: o.method,
      headers,
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    }),
    env,
    db,
    path.split("?")[0]!,
    { now: NOW },
  );
  const text = await res.text();
  let body: Record<string, any> = {};
  try {
    body = JSON.parse(text) as Record<string, any>;
  } catch {
    /* not JSON */
  }
  return { status: res.status, body, text };
}
