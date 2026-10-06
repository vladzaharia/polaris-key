/// <reference types="@cloudflare/workers-types" />

/**
 * `GET|PATCH /manage/api/products/<slug>/services` and `POST …/services/revert` (plan §R4).
 *
 * The operator's half of the enablement authority. `services_json` is manifest-fed, but a
 * product's services must also be changeable live — an operator disabling a misbehaving feed at
 * 3am cannot be made to open a pull request first — and that is only coherent if the next push
 * cannot silently undo them. So the column carries an owner (`services_source`), exactly as the
 * fingerprint and auto-issue policies do:
 *
 *   PATCH  claims the row for `admin`; resyncs stop writing it (the guard is the UPDATE's own
 *          WHERE clause in `setServices`, not a read-then-write here).
 *   revert hands it back to `manifest`.
 *
 * ── WHY THIS LIVES IN CORE ──────────────────────────────────────────────────────────────────
 *
 * It edits which SERVICES exist, so it cannot belong to any of them — a service that owned its
 * own off switch would have to be running to be turned off. Core owns the registry, so Core owns
 * the row the registry reads.
 *
 * ── WHAT `revert` DOES, PRECISELY ───────────────────────────────────────────────────────────
 *
 * It flips `services_source` back to `manifest` and NOTHING else. It does not re-fetch the repo,
 * does not re-derive a set, and does not change the live enablement: the values stay exactly as
 * the operator left them until the next resync (a push, or `POST …/release/resync`) re-applies
 * the manifest through `setServices`, which is now permitted to write again.
 *
 * That is deliberate, not a shortcut. The alternative — reverting by immediately re-reading the
 * repo — turns one admin click into a GitHub round-trip that can fail, time out, or apply a
 * manifest nobody in the room has read, and it does it on the operator's only escape hatch. The
 * response says which state the product is in so the console can tell the operator that the
 * manifest re-applies on the next sync rather than pretending it already has.
 */

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import type { AdminSession } from "../admin/session.js";
import {
  adminJson,
  err,
  notFound,
  readBody,
  settingRefused,
} from "../admin/lib/respond.js";
import { ErrorCode } from "./errors.js";
import { getProduct } from "../repo.js";
import type { SettingsRegistry } from "./settings/registry.js";
import { writeSetting, type WriteOptions } from "./settings/write.js";
import { invalidateWidenedEdgeMintApprovals } from "./edgeMintApproval.js";
import {
  parseServices,
  resolveRegistration,
  REGISTRATION_POLICIES,
  serviceStateOf,
  SERVICE_SLUGS,
  serializeServices,
  validateServices,
  type ProductServices,
  type RegistrationPolicy,
  type ServiceSlug,
} from "./services.js";
import {
  applyServiceTransitions,
  countSignedInDevices,
} from "./servicesTransitions.js";

function isRegistrationPolicy(value: unknown): value is RegistrationPolicy {
  return (
    typeof value === "string" &&
    (REGISTRATION_POLICIES as readonly string[]).includes(value)
  );
}

export async function handleServicesAdmin(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  action: string | undefined,
  now: number,
  settings: SettingsRegistry,
): Promise<Response> {
  const row = await getProduct(db, slug);
  if (!row) return notFound();
  // ST-04: `core.services` is a registry setting, written through the one write path (its legacy
  // `services_source` marker is claimed and released by its column adapter). A bespoke route:
  // no version in its contract (ST-05 makes it an alias of the generic API).
  const ctx = { env, db, registry: settings };
  const opts = (origin: "console" | "revert"): WriteOptions => ({
    actor: {
      sub: session.sub,
      name: session.name ?? null,
      email: session.email ?? null,
    },
    origin,
    now,
    product: row,
    strict: false,
  });

  if (action === "revert") {
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    // P0-12: sweep before every console write of an edge-mint approval input (see the PATCH).
    await invalidateWidenedEdgeMintApprovals(
      db,
      slug,
      now,
      "found widened before a console edit",
    );
    const reverted = await writeSetting(
      ctx,
      {
        key: "core.services",
        op: "reset",
        audit: {
          action: "product.services.revert",
          target: { kind: "product", id: slug },
          summary: `Returned service enablement for ${slug} to manifest control; the manifest re-applies on the next resync`,
        },
      },
      opts("revert"),
    );
    if (!reverted.ok) return settingRefused(reverted);
    // PX-W17: the values did not change, but the transition hook is idempotent and heals any
    // binding left on an Identity-off product.
    await applyServiceTransitions(
      env,
      db,
      slug,
      parseServices(row.services_json).services,
      session,
      now,
    );
    return adminJson(serviceStateOf(await getProduct(db, slug)));
  }
  if (action !== undefined) return notFound();

  if (req.method === "GET") return adminJson(serviceStateOf(row));
  if (req.method !== "PATCH")
    return err(405, ErrorCode.BadRequest, "method not allowed");

  const body = await readBody(req);
  const current = parseServices(row.services_json);
  const fields: string[] = [];

  // Partial patch, like the fingerprint policy: an omitted slug keeps its current value rather
  // than reverting to a default, so a console that only knows about three services cannot turn
  // off the two it has never heard of.
  const services = { ...current.services };
  if (body.services !== undefined) {
    if (
      !body.services ||
      typeof body.services !== "object" ||
      Array.isArray(body.services)
    ) {
      fields.push("services");
    } else {
      const patch = body.services as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (!(SERVICE_SLUGS as readonly string[]).includes(key)) {
          fields.push(`services.${key}`);
          continue;
        }
        const enabled =
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>).enabled
            : undefined;
        if (typeof enabled !== "boolean") {
          fields.push(`services.${key}.enabled`);
          continue;
        }
        services[key as ServiceSlug] = { enabled };
      }
    }
  }

  // `registration: null` CLEARS the declaration and returns the product to the derived default;
  // omitting the key leaves whatever is stored. The two are different requests and the API has
  // to be able to express both, or a product could never get back to "follow the services".
  let registration = current.registration;
  if (body.registration !== undefined) {
    if (body.registration === null) registration = undefined;
    else if (isRegistrationPolicy(body.registration))
      registration = body.registration;
    else fields.push("registration");
  }

  if (fields.length > 0)
    return err(422, ErrorCode.BadRequest, "invalid services", { fields });

  const errors = validateServices(services, registration);
  if (errors.length > 0)
    return err(422, ErrorCode.BadRequest, "incoherent services", { errors });

  // `unknown` rides through untouched: a slug a newer build wrote is not ours to drop.
  const next: ProductServices = {
    services,
    ...(registration === undefined ? {} : { registration }),
    ...(current.unknown ? { unknown: current.unknown } : {}),
  };

  // PX-W17: `?dryRun=1` answers what this PATCH would change, with no write, so the console can
  // confirm turning Identity off with the number of devices it signs out.
  if (new URL(req.url).searchParams.get("dryRun") === "1") {
    const changes: Array<{ field: string; from: unknown; to: unknown }> = [];
    for (const s of SERVICE_SLUGS) {
      if (current.services[s].enabled !== services[s].enabled)
        changes.push({
          field: `services.${s}.enabled`,
          from: current.services[s].enabled,
          to: services[s].enabled,
        });
    }
    if ((current.registration ?? null) !== (registration ?? null))
      changes.push({
        field: "registration",
        from: current.registration ?? null,
        to: registration ?? null,
      });
    return adminJson({
      changes,
      signedInDevicesToClear: services.identity.enabled
        ? 0
        : await countSignedInDevices(db, slug),
    });
  }
  // P0-12: drop every edge-mint approval the product has ALREADY widened before the console
  // writes an approval input. The ingest's own sweep is not enough on its own: a push whose
  // Worker is killed after its un-batched widening writes (CPU limit, cancelled request) never
  // reaches it, and an approve that races a push's sweep can land after it. Without this, an
  // operator's natural fix — turning the widening back off here — would make the approval apply
  // again for everyone who enrolled or signed in meanwhile. Sweeping first means no revert path
  // can be the first thing to look at a widened approval.
  await invalidateWidenedEdgeMintApprovals(
    db,
    slug,
    now,
    "found widened before a console edit",
  );
  const enabled = SERVICE_SLUGS.filter((s) => services[s].enabled);
  const written = await writeSetting(
    ctx,
    {
      key: "core.services",
      // The stored shape (`serializeServices`), so the value round-trips through the parser.
      value: JSON.parse(serializeServices(next)) as unknown,
      audit: {
        action: "product.services.update",
        target: { kind: "product", id: slug },
        summary:
          `Set services for ${slug}: ${enabled.length ? enabled.join(", ") : "none"}; ` +
          `registration ${registration ?? `derived (${resolveRegistration(services)})`}`,
      },
    },
    opts("console"),
  );
  if (!written.ok) return settingRefused(written);
  await applyServiceTransitions(env, db, slug, services, session, now);
  return adminJson(serviceStateOf(await getProduct(db, slug)));
}
