/**
 * The alert destinations admin API (ST-27), in both scopes. The dispatcher's route table has
 * already checked the area (`platform` for the platform's, `settings` for a product's) and, for
 * a write that can aim alerts at a new place, the console step-up.
 *
 *   GET    …/alerts              — `{ destinations, kinds, max, emailAvailable }`
 *   POST   …/alerts              — `{ kind, target, label?, alerts }`: 201 `{ destination, secret? }`
 *   PATCH  …/alerts/:id          — `{ target?, label?, alerts?, enabled?, rotateSecret?, expectedVersion? }`
 *   DELETE …/alerts/:id          — `{ expectedVersion? }` in the body or `?expectedVersion=`
 *   POST   …/alerts/:id/test     — one test alert to that destination; `{ outcome }`
 *
 * `…` is `/api/platform` or `/api/products/<slug>`. A webhook's `target` is its https URL: write
 * only. A response carries the address, or `https://host/…`, never the URL; `secret` is the
 * webhook's signing secret, present on the create and on a rotate and nowhere else. Every write
 * is audited (`core/notify/alertDestinations.ts`).
 *
 * Rule 10: in the OpenAPI spec (`/manage/api/platform/alerts…`, `/manage/api/products/{product}/alerts…`).
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import {
  AdminBodyError,
  adminJson,
  err,
  notFound,
  readBody,
} from "../../core/console/respond.js";
import type { AdminSession } from "../../core/console/session.js";
import { ErrorCode } from "../../core/errors.js";
import {
  ALERT_KINDS,
  ALERT_KIND_LABELS,
  MAX_DESTINATIONS_PER_SCOPE,
  PLATFORM_SCOPE,
  createDestination,
  deleteDestination,
  listDestinations,
  testDestination,
  updateDestination,
  type Failure,
} from "../../core/notify/alertDestinations.js";
import { emailConfigured } from "../../core/notify/destinations.js";

const ID_RE = /^dst_[A-Za-z0-9_-]{6,40}$/;

function refused(f: Failure): Response {
  return err(
    f.status,
    f.status === 404 ? ErrorCode.NotFound : ErrorCode.BadRequest,
    f.message,
    {
      reason: f.reason,
    },
  );
}

/** `scope` is `PLATFORM_SCOPE` or a product slug. `rest` is the path after `alerts`. */
export async function handleAlertDestinations(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  scope: string,
  rest: readonly string[],
  now: number,
): Promise<Response> {
  const actor = {
    sub: session.sub,
    name: session.name ?? null,
    email: session.email ?? null,
  };
  try {
    if (rest.length === 0) {
      if (req.method === "GET")
        return adminJson({
          destinations: await listDestinations(db, scope),
          kinds: ALERT_KINDS.map((id) => ({
            id,
            label: ALERT_KIND_LABELS[id],
          })),
          max: MAX_DESTINATIONS_PER_SCOPE,
          emailAvailable: emailConfigured(env),
          ...(scope === PLATFORM_SCOPE
            ? {}
            : {
                inherited: (await listDestinations(db, PLATFORM_SCOPE)).filter(
                  (d) => d.enabled,
                ).length,
              }),
        });
      if (req.method === "POST") {
        const res = await createDestination(
          env,
          db,
          scope,
          actor,
          await readBody(req),
          now,
        );
        if (!res.ok) return refused(res);
        return adminJson(
          {
            destination: res.destination,
            ...(res.secret ? { secret: res.secret } : {}),
          },
          201,
        );
      }
      return err(405, "method_not_allowed", "method not allowed");
    }
    const id = rest[0]!;
    if (!ID_RE.test(id)) return notFound();
    if (rest.length === 2 && rest[1] === "test") {
      if (req.method !== "POST")
        return err(405, "method_not_allowed", "method not allowed");
      const res = await testDestination(env, db, scope, actor, id, now);
      return res.ok ? adminJson({ outcome: res.outcome }) : refused(res);
    }
    if (rest.length !== 1) return notFound();
    if (req.method === "PATCH") {
      const body = await readBody(req);
      const res = await updateDestination(env, db, scope, actor, id, body, now);
      if (!res.ok) return refused(res);
      return adminJson({
        destination: res.destination,
        ...(res.secret ? { secret: res.secret } : {}),
      });
    }
    if (req.method === "DELETE") {
      const q = new URL(req.url).searchParams.get("expectedVersion");
      const body =
        req.headers.get("content-length") === "0"
          ? {}
          : await readBody(req).catch(() => ({}));
      const expected =
        body.expectedVersion ?? (q !== null ? Number(q) : undefined);
      const res = await deleteDestination(db, scope, actor, id, expected, now);
      return res.ok ? adminJson({ ok: true }) : refused(res);
    }
    return err(405, "method_not_allowed", "method not allowed");
  } catch (e) {
    if (e instanceof AdminBodyError)
      return err(e.status, e.code, e.message, e.extra);
    throw e;
  }
}
