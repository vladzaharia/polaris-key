/**
 * App Store Connect controls (P5-02; README §11 decision 7: read-only state first, controls
 * second, uploads never). Reached from Distribution's admin surface —
 * `POST /manage/api/products/<slug>/distribution/connectors/asc/<control>` — so the session,
 * CSRF, rate-limit and platform-admin gates have already run.
 *
 *     phased-release/pause     PATCH /v1/appStoreVersionPhasedReleases/{id}  PAUSED
 *     phased-release/resume    PATCH …                                       ACTIVE
 *     phased-release/complete  PATCH …                                       COMPLETE (typed)
 *     release                  POST  /v1/appStoreVersionReleaseRequests  (a version held in
 *                                                                         PENDING_DEVELOPER_RELEASE;
 *                                                                         typed confirmation, A-17a)
 *     testflight/public-link   PATCH /v1/betaGroups/{id}  publicLinkEnabled
 *     webhook                  POST  /v1/webhooks (all 12 event types), then POST /v1/webhookPings
 *
 * **The operator's app, or nothing.** Every control first resolves the setup, and the setup
 * exists only when the `asc-api-key` credential is pinned to the `appleId` the manifest names
 * (`setup.ts`, P5-02f). A missing pin answers 409 `credential_pin_missing`, a different one 409
 * `credential_pin_mismatch`, both before any token is minted or request sent — so a repo writer
 * who changes `.pkey/distribution` cannot aim these controls at another app the team key sees.
 *
 * **Ownership before every write.** A version control acts only on a stored version of the app
 * the setup names now (`versionObjectForRelease`), and first RE-READS it from Apple with
 * `include=app` (`proveVersion`): unless Apple says it is this app's version of this release,
 * nothing is sent — the team-scoped key could otherwise release or complete another app's
 * version, which no later re-read can undo. The public-link control proves its beta group the
 * same way.
 *
 * **The write gate (A-17a).** Every request goes through Core's client, whose deny-by-default gate
 * (`core/storefront/rules/appStore.ts`) admits exactly these writes and refuses the release request unless the
 * control asserts the typed confirmation it checked (`confirm` = the app's name).
 *
 * Every control sends exactly the documented request, writes ONE audit row with the session's
 * subject (`distribution.asc.<control>`), and then RE-READS the object from the API, so what the
 * console shows afterwards is Apple's answer, not the request's intent. Apple refusing a request
 * (an invalid transition, a version not held) is relayed as 409 `store_refused` with the status
 * Apple gave and nothing of its body but its `errors[0].code` token (`appleCode`). The Distribute
 * flow (builds, TestFlight, versions, submit for review) is `distribute.ts` (A-17d).
 *
 * "Register webhook" uses a secret stored beforehand as an `asc-webhook-secret` outlet
 * credential — generated server-side by the Core admin handler (`PUT …/outlet-credentials/<id>`
 * with `generate: true`), because no Distribution code may write a credential (P5-01's reach
 * test). The secret is opened here (audited `asc:register-webhook`) and sent to Apple once.
 */

import {
  confirmationMissing,
  typedConfirmationRefusal,
} from "../../../../core/storefront/confirm.js";
import { APP_STORE_ADAPTER } from "../../../../core/storefront/stores/appStore.js";
import type { Db } from "../../../../db/types.js";
import type { Env } from "../../../../env.js";
import type { ServiceHooks } from "../../../../core/hooks.js";
import { audit } from "../../../../admin/audit.js";
import type { AdminSession } from "../../../../admin/session.js";
import { openOutletCredential } from "../../../../core/outletCredentials.js";
import { getRollout, rolloutRecord } from "../../rollouts.js";
import { upsertObject } from "../state.js";
import {
  syncAppStoreVersion,
  versionObjectForRelease,
  type AscRun,
} from "./apply.js";
import {
  AscError,
  AscWriteDenied,
  ascPath,
  attr,
  relId,
  single,
  type FetchImpl,
} from "../../../../core/asc/client.js";
import { ASC_WEBHOOK_EVENT_TYPES } from "./map.js";
import { ascRun, finishRun } from "./run.js";
import { ASC_CONNECTOR, resolveAscSetup, type AscSetup } from "./setup.js";

export interface ControlContext {
  env: Env;
  db: Db;
  product: string;
  hooks: ServiceHooks;
  now: number;
  session: AdminSession;
  /** The origin the console was reached on: the webhook URL is built from it. */
  origin: string;
  /**
   * The request's `Idempotency-Key` header (one per user intent; S-14 §7.3), or null. The
   * ledger-backed controls (A-17c's setup controls in `provision.ts`, A-17d's Distribute writes)
   * require it and key their ledger steps by it; the P5-02 controls ignore it.
   */
  idempotencyKey?: string | null;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
}

export type ControlResult =
  | { ok: true; [k: string]: unknown }
  | {
      ok: false;
      status: 404 | 409 | 422 | 428 | 502;
      reason: string;
      message: string;
      fields?: string[];
      /** Apple's `errors[0].code` token on a `store_refused` (never its free text). */
      appleCode?: string;
    };

export type ConnectorControl = (
  c: ControlContext,
  body: Record<string, unknown>,
) => Promise<ControlResult>;

/** A connector read under `GET …/connectors/<kind>/<path>` (A-17d's Distribute reads). */
export type ConnectorRead = (
  c: ControlContext,
  query: URLSearchParams,
) => Promise<ControlResult>;

export const refuse = (
  status: 404 | 409 | 422 | 428 | 502,
  reason: string,
  message: string,
  fields?: string[],
): ControlResult => ({
  ok: false,
  status,
  reason,
  message,
  ...(fields ? { fields } : {}),
});

/** Run `fn` against a fresh connector run; Apple's refusals become `store_refused`. */
export async function withRun(
  c: ControlContext,
  fn: (run: AscRun, setup: AscSetup) => Promise<ControlResult>,
): Promise<ControlResult> {
  const { setup, inert } = await resolveAscSetup(c.env, c.db, c.product);
  if (!setup) {
    // The operator's pin and the manifest disagree (or there is no pin): refuse with the reason,
    // before any token is minted or any request is sent. Nothing a control does is reversible
    // enough to run against an app the operator did not choose.
    if (inert.reason === "pin_missing" || inert.reason === "pin_mismatch")
      return refuse(409, `credential_${inert.reason}`, inert.message);
    return refuse(
      404,
      "not_configured",
      "App Store Connect is not configured: declare an app-store or testflight outlet with an appleId and store an asc-api-key credential pinned to that app",
    );
  }
  const run = ascRun({
    env: c.env,
    db: c.db,
    product: c.product,
    hooks: c.hooks,
    now: c.now,
    setup,
    use: "asc:control",
    ...(c.fetchImpl ? { fetchImpl: c.fetchImpl } : {}),
    ...(c.sleep ? { sleep: c.sleep } : {}),
  });
  let error: unknown = null;
  try {
    return await fn(run, setup);
  } catch (e) {
    error = e;
    // The write gate refused before anything was minted or sent (core/storefront/rules/appStore.ts).
    if (e instanceof AscWriteDenied)
      return refuse(409, "write_denied", e.message);
    if (e instanceof AscError) {
      const refused = refuse(
        e.status === 404
          ? 404
          : e.status >= 500 || e.status === 429
            ? 502
            : 409,
        "store_refused",
        e.message,
      );
      // Apple's enum-like code (`ENTITY_ERROR.ATTRIBUTE.INVALID`, A-17h), never its body.
      return e.code && !refused.ok
        ? { ...refused, appleCode: e.code }
        : refused;
    }
    throw e;
  } finally {
    await finishRun(run, error);
  }
}

function auditControl(
  c: ControlContext,
  control: string,
  target: string,
  summary: string,
): Promise<void> {
  return audit(
    c.db,
    c.product,
    c.session,
    c.now,
    `distribution.asc.${control}`,
    { kind: "asc", id: target },
    summary,
  );
}

/**
 * The App Store version a control may write to for `releaseId`, proven NOW: the stored row of
 * this app's version, re-read from Apple (ownership, presence, current state) before anything is
 * sent. `null` when no row is linked, or the re-read does not come back as this app's version of
 * this release (another app's, gone, another platform's).
 */
async function proveVersion(
  run: AscRun,
  setup: AscSetup,
  releaseId: string,
): Promise<Awaited<ReturnType<typeof versionObjectForRelease>>> {
  const stored = await versionObjectForRelease(
    run.db,
    run.product,
    setup.appleId,
    releaseId,
  );
  if (!stored) return null;
  const outcome = await syncAppStoreVersion(run, stored.versionId);
  if (outcome !== "applied" && outcome !== "unresolved") return null;
  const fresh = await versionObjectForRelease(
    run.db,
    run.product,
    setup.appleId,
    releaseId,
  );
  return fresh && fresh.versionId === stored.versionId ? fresh : null;
}

function releaseIdOf(body: Record<string, unknown>): string | null {
  return typeof body.releaseId === "string" && body.releaseId !== ""
    ? body.releaseId
    : null;
}

// ── Phased release ───────────────────────────────────────────────────────────────────────────

const PHASED_TARGET = {
  pause: "PAUSED",
  resume: "ACTIVE",
  complete: "COMPLETE",
} as const;

/** What the typed confirmation of `phased-release/complete` names in its refusal. */
const COMPLETE_ACTION = "release the version to every user";

function phasedControl(verb: keyof typeof PHASED_TARGET): ConnectorControl {
  return (c, body) =>
    withRun(c, async (run, setup) => {
      const releaseId = releaseIdOf(body);
      if (!releaseId)
        return refuse(422, "invalid_body", "releaseId is required", [
          "releaseId",
        ]);
      // Completing releases the version to every user at once, so it is a release: typed like
      // `release` (owner decision (b), 2026-10-04). Pause and resume stay plain.
      const typed = verb === "complete";
      if (
        typed &&
        (typeof body.confirm !== "string" || body.confirm.trim() === "")
      )
        return refuse(
          422,
          "confirmation_required",
          `type the app's name in confirm to ${COMPLETE_ACTION}`,
          ["confirm"],
        );
      const known = await proveVersion(run, setup, releaseId);
      if (!known)
        return refuse(
          404,
          "unknown_version",
          `no App Store version of this app is linked to ${releaseId}`,
        );
      const phasedId = known.phasedId;
      if (!phasedId)
        return refuse(
          404,
          "no_phased_release",
          `the App Store version of ${releaseId} has no phased release`,
        );
      if (typed) {
        const unconfirmed = await checkTypedConfirmation(
          run,
          setup,
          body.confirm,
          COMPLETE_ACTION,
        );
        if (unconfirmed) return unconfirmed;
      }
      const state = PHASED_TARGET[verb];
      await run.client.patch(
        ascPath("appStoreVersionPhasedReleases", phasedId),
        {
          data: {
            type: "appStoreVersionPhasedReleases",
            id: phasedId,
            attributes: { phasedReleaseState: state },
          },
        },
        // Asserted only after the comparison above; the gate refuses COMPLETE without it.
        typed ? { typedConfirmation: true } : {},
      );
      await auditControl(
        c,
        `phased_release.${verb}`,
        phasedId,
        `Set the App Store phased release of ${releaseId} to ${state}`,
      );
      await syncAppStoreVersion(run, known.versionId);
      const outlet = setup.appStoreOutlet;
      const rollout = outlet
        ? await c.db.first<{ channel: string }>(
            `SELECT channel FROM dist_rollouts
              WHERE product = ? AND outlet_id = ? AND release_id = ? AND mirrored = 1`,
            c.product,
            outlet,
            releaseId,
          )
        : null;
      const row =
        outlet && rollout
          ? await getRollout(c.db, c.product, "app", outlet, rollout.channel)
          : null;
      return {
        ok: true,
        phasedReleaseId: phasedId,
        rollout: row ? rolloutRecord(row) : null,
      };
    });
}

// ── Release a held version ───────────────────────────────────────────────────────────────────

/**
 * A-17a: releasing is irreversible, so it takes a TYPED confirmation (owner decision,
 * 2026-10-04; ADMIN.md §5.2): the body's `confirm` must equal the app's name as App Store Connect
 * reports it now. Only after that comparison does the control assert `typedConfirmation` to the
 * write gate, which refuses the release request without it. A-17d's submit for review uses the
 * same check (`action` names what is being confirmed in the refusal). The comparison is the shared
 * one every store uses (`core/storefront/confirm.ts`), with the Apple adapter's phrase.
 */
export async function checkTypedConfirmation(
  run: AscRun,
  setup: AscSetup,
  typed: unknown,
  action = "release",
): Promise<ControlResult | null> {
  const missing = confirmationMissing(typed, action);
  if (missing)
    return refuse(missing.status, missing.reason, missing.message, [
      ...missing.fields,
    ]);
  const app = single(
    await run.client.get(ascPath("apps", setup.appleId), {
      "fields[apps]": "name",
    }),
  );
  const refusal = typedConfirmationRefusal(
    typed,
    attr(app, "name"),
    action,
    APP_STORE_ADAPTER.confirmation,
  );
  return refusal
    ? refuse(refusal.status, refusal.reason, refusal.message, [
        ...refusal.fields,
      ])
    : null;
}

const releaseHeld: ConnectorControl = (c, body) =>
  withRun(c, async (run, setup) => {
    const releaseId = releaseIdOf(body);
    if (!releaseId)
      return refuse(422, "invalid_body", "releaseId is required", [
        "releaseId",
      ]);
    if (typeof body.confirm !== "string" || body.confirm.trim() === "")
      return refuse(
        422,
        "confirmation_required",
        "type the app's name in confirm to release",
        ["confirm"],
      );
    // Apple's answer, not the stored one, decides whether the version is held.
    const known = await proveVersion(run, setup, releaseId);
    if (!known)
      return refuse(
        404,
        "unknown_version",
        `no App Store version of this app is linked to ${releaseId}`,
      );
    if (known.storeState !== "PENDING_DEVELOPER_RELEASE")
      return refuse(
        409,
        "not_held",
        `the App Store version of ${releaseId} is ${known.storeState ?? "in an unknown state"}, not PENDING_DEVELOPER_RELEASE`,
      );
    const unconfirmed = await checkTypedConfirmation(run, setup, body.confirm);
    if (unconfirmed) return unconfirmed;
    await run.client.post(
      ascPath("appStoreVersionReleaseRequests"),
      {
        data: {
          type: "appStoreVersionReleaseRequests",
          relationships: {
            appStoreVersion: {
              data: { type: "appStoreVersions", id: known.versionId },
            },
          },
        },
      },
      { typedConfirmation: true },
    );
    await auditControl(
      c,
      "release",
      known.versionId,
      `Released the held App Store version of ${releaseId}`,
    );
    await syncAppStoreVersion(run, known.versionId);
    const after = await versionObjectForRelease(
      c.db,
      c.product,
      setup.appleId,
      releaseId,
    );
    return {
      ok: true,
      versionId: known.versionId,
      ascState: after?.storeState ?? null,
    };
  });

// ── TestFlight public link ───────────────────────────────────────────────────────────────────

const GROUP_ID = /^[A-Za-z0-9-]{1,128}$/;

const publicLink: ConnectorControl = (c, body) =>
  withRun(c, async (run, setup) => {
    const groupId = body.betaGroupId;
    if (typeof groupId !== "string" || !GROUP_ID.test(groupId))
      return refuse(422, "invalid_body", "betaGroupId is required", [
        "betaGroupId",
      ]);
    if (typeof body.enabled !== "boolean")
      return refuse(422, "invalid_body", "enabled must be a boolean", [
        "enabled",
      ]);
    // The group must be this product's app's: a beta group id is all a request carries.
    const before = single(
      await run.client.get(ascPath("betaGroups", groupId), { include: "app" }),
    );
    if (!before || relId(before, "app") !== setup.appleId)
      return refuse(
        404,
        "unknown_beta_group",
        `no beta group ${groupId} on this app`,
      );
    await run.client.patch(ascPath("betaGroups", groupId), {
      data: {
        type: "betaGroups",
        id: groupId,
        attributes: { publicLinkEnabled: body.enabled },
      },
    });
    await auditControl(
      c,
      "testflight.public_link",
      groupId,
      `${body.enabled ? "Enabled" : "Disabled"} the TestFlight public link of beta group ${attr(before, "name") ?? groupId}`,
    );
    const after = single(await run.client.get(ascPath("betaGroups", groupId)));
    const enabled = after?.attributes?.publicLinkEnabled === true;
    await upsertObject(
      { db: c.db, product: c.product, now: c.now },
      ASC_CONNECTOR,
      {
        type: "betaGroups",
        id: groupId,
        outletId: setup.testflightOutlet,
        releaseId: null,
        buildId: "",
        storeState: enabled ? "PUBLIC_LINK_ENABLED" : "PUBLIC_LINK_DISABLED",
        state: null,
        ref: { ascAppId: setup.appleId, ascBetaGroupId: groupId },
        detail: {
          name: attr(after, "name"),
          publicLinkEnabled: enabled,
          publicLink: attr(after, "publicLink"),
        },
        terminal: true,
      },
    );
    return {
      ok: true,
      betaGroupId: groupId,
      publicLinkEnabled: enabled,
      publicLink: attr(after, "publicLink"),
    };
  });

// ── Register the webhook ─────────────────────────────────────────────────────────────────────

/** The route Apple is told to call. */
export function webhookUrl(origin: string, product: string): string {
  return `${origin}/${product}/distribution/hooks/asc`;
}

const registerWebhook: ConnectorControl = (c) =>
  withRun(c, async (run, setup) => {
    if (!setup.webhookSecretId)
      return refuse(
        409,
        "no_webhook_secret",
        "store an asc-webhook-secret outlet credential first (PUT …/outlet-credentials/<id> with generate: true)",
      );
    const secret = await openOutletCredential(
      c.env,
      c.db,
      c.product,
      setup.webhookSecretId,
      "asc:register-webhook",
      { kind: "asc-webhook-secret", now: c.now },
    );
    if (!secret)
      return refuse(
        409,
        "no_webhook_secret",
        "the asc-webhook-secret credential is unusable",
      );
    const url = webhookUrl(c.origin, c.product);
    const created = single(
      await run.client.post(
        ascPath("webhooks"),
        {
          data: {
            type: "webhooks",
            attributes: {
              enabled: true,
              eventTypes: [...ASC_WEBHOOK_EVENT_TYPES],
              name: `Polaris Key (${c.product})`,
              secret: secret.value.secret,
              url,
            },
            relationships: {
              app: { data: { type: "apps", id: setup.appleId } },
            },
          },
        },
        // The gate admits the callback URL only on the origin this request arrived at.
        { hookOrigin: c.origin },
      ),
    );
    if (!created)
      return refuse(
        502,
        "store_refused",
        "App Store Connect created no webhook",
      );
    await run.client.post(ascPath("webhookPings"), {
      data: {
        type: "webhookPings",
        relationships: {
          webhook: { data: { type: "webhooks", id: created.id } },
        },
      },
    });
    await auditControl(
      c,
      "webhook.register",
      created.id,
      `Registered the App Store Connect webhook ${created.id} for app ${setup.appleId} → ${url}`,
    );
    const after = single(await run.client.get(ascPath("webhooks", created.id)));
    await upsertObject(
      { db: c.db, product: c.product, now: c.now },
      ASC_CONNECTOR,
      {
        type: "webhooks",
        id: created.id,
        outletId: null,
        releaseId: null,
        buildId: "",
        storeState:
          after?.attributes?.enabled === true ? "ENABLED" : "DISABLED",
        state: null,
        ref: { ascAppId: setup.appleId, ascWebhookId: created.id },
        detail: { url: attr(after, "url") ?? url },
        terminal: true,
      },
    );
    return {
      ok: true,
      webhookId: created.id,
      url,
      enabled: after?.attributes?.enabled === true,
    };
  });

/** The control table: path under `…/connectors/asc/` → implementation. */
export const ASC_CONTROLS: Readonly<Record<string, ConnectorControl>> = {
  "phased-release/pause": phasedControl("pause"),
  "phased-release/resume": phasedControl("resume"),
  "phased-release/complete": phasedControl("complete"),
  release: releaseHeld,
  "testflight/public-link": publicLink,
  webhook: registerWebhook,
};
