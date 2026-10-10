/**
 * Driving `/manage/api/platform/store-connections/…` (A-16) through the real admin dispatcher,
 * as a platform admin (or, with `groups`, as anyone), with a fake as the global fetch.
 */

import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import { CONSOLE } from "./releaseRoutesFixture.js";
import { NOW } from "./seed.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function platformApi(
  w: { env: Env; db: Db; fetchImpl?: FetchLike },
  method: string,
  path: string,
  body?: unknown,
  groups: string[] = ["platform-admins"],
): Promise<Response> {
  const { token, session } = await issueSession(
    w.env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups },
    NOW,
  );
  const [bare, query] = path.split("?");
  const full = `/api/platform/store-connections${bare}`;
  const saved = globalThis.fetch;
  if (w.fetchImpl) globalThis.fetch = w.fetchImpl as typeof fetch;
  try {
    return await handleAdmin(
      new Request(`${CONSOLE}/manage${full}${query ? `?${query}` : ""}`, {
        method,
        headers: {
          cookie: `${ADMIN_COOKIE}=${token}`,
          [CSRF_HEADER]: session.csrf,
          "content-type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      w.env,
      w.db,
      full,
      { now: NOW },
    );
  } finally {
    globalThis.fetch = saved;
  }
}

export async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** Every product-trail audit row of `product`, oldest first. */
export async function productAudits(
  db: Db,
  product: string,
): Promise<
  Array<{
    action: string;
    actor_sub: string;
    target_id: string;
    summary: string;
  }>
> {
  return db.all(
    "SELECT action, actor_sub, target_id, summary FROM audit WHERE product = ? ORDER BY rowid",
    product,
  );
}
