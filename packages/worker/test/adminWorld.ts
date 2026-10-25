/**
 * The admin-test world: a migrated database, a KV, an `Env` with the console session secret and
 * platform-admin group set, products seeded, one signed-in operator, and `call` to drive `/manage`
 * through `handleAdmin`. New admin tests start here instead of hand-building the cookie, CSRF
 * header and request each time.
 */
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { consoleTestSession } from "./consoleSessionHelper.js";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import { handleAdmin } from "../src/console/index.js";
import {
  CSRF_HEADER,
  type SessionIdentity,
} from "../src/core/console/session.js";

export interface AdminLogin {
  cookie: string;
  csrf: string;
  /** The member id the console resolves (the audit actor). */
  sub: string;
}

export interface AdminWorldOptions {
  /** Products to seed (default none). */
  products?: string[];
  groups?: {
    /** The platform-admin group (default `platform-admins`). */
    platform?: string;
  };
}

export interface AdminCallOptions {
  body?: unknown;
  /** Who calls: a `login()` result (default the world's operator), or `null` for no session. */
  as?: Pick<AdminLogin, "cookie" | "csrf"> | null;
  headers?: Record<string, string>;
}

export interface AdminWorld {
  db: Db;
  kv: KvMock;
  env: Env;
  /** The signed-in platform operator (`u1`, in the platform group). */
  admin: AdminLogin;
  /** Sign `identity` in and return its cookie and CSRF token. */
  login(identity: SessionIdentity): Promise<AdminLogin>;
  /** `path` is below `/manage`, e.g. `/api/products/djdl/devices?limit=5`. */
  call(
    method: string,
    path: string,
    opts?: AdminCallOptions,
  ): Promise<Response>;
}

export async function adminWorld(
  opts: AdminWorldOptions = {},
): Promise<AdminWorld> {
  const platform = opts.groups?.platform ?? "platform-admins";
  const db = makeTestDb();
  const kv = new KvMock();
  const env = makeEnv(kv, opts.products);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = platform;
  for (const slug of opts.products ?? []) await seedProduct(db, slug);

  const login = async (identity: SessionIdentity): Promise<AdminLogin> => {
    const { cookie, csrf, session } = await consoleTestSession(
      env,
      db,
      identity,
      NOW,
    );
    return { cookie, csrf, sub: session.sub };
  };
  const admin = await login({
    sub: "u1",
    name: "Ada",
    email: "ada@x.io",
    groups: [platform],
  });

  const call = (
    method: string,
    path: string,
    o: AdminCallOptions = {},
  ): Promise<Response> => {
    const who = o.as === undefined ? admin : o.as;
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (who) {
      headers.cookie = who.cookie;
      if (who.csrf) headers[CSRF_HEADER] = who.csrf;
    }
    if (o.body !== undefined) headers["content-type"] = "application/json";
    return handleAdmin(
      new Request(`https://key.plrs.im/manage${path}`, {
        method,
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      }) as unknown as Request,
      env,
      db,
      path.split("?")[0]!,
      { now: NOW },
    );
  };
  return { db, kv, env, admin, login, call };
}
