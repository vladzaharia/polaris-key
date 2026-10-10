/**
 * Google Play controls (P5-03). Reached from Distribution's admin surface —
 * `POST /manage/api/products/<slug>/distribution/connectors/play/<control>` — so the session,
 * CSRF, rate-limit and platform-admin gates have already run.
 *
 *     rollout/fraction   set `userFraction` (0 < f < 1); on a draft this STARTS the rollout, and
 *                        a draft with no priority gets the policy priority first
 *     rollout/halt       inProgress → halted; a completed release only with confirmRollback
 *     rollout/resume     halted → inProgress (or → completed, for a halted completed release)
 *     rollout/complete   inProgress → completed
 *     priority           set `inAppUpdatePriority` (0–5, or the policy's when omitted) on a
 *                        release that has not started rolling out; refused once it has
 *     settings           the operator's priority default and vitals auto-halt settings
 *
 * The rollout controls and `priority` take `{track, versionCode | releaseId, …}`. Each is ONE
 * edit: `edits.insert` → `edits.tracks.get` → `edits.tracks.patch` (the track's releases as read,
 * only the target changed — `map.ts` `planControl`) → `edits.commit` with
 * `changesInReviewBehavior=ERROR_IF_IN_REVIEW`; a refusal before the commit, or a failed commit,
 * deletes the edit. Then ONE audit row (`distribution.play.<verb>`), then a RE-READ through a
 * fresh edit, whose answer is what the mirror shows: Play may take hours to propagate a commit,
 * so nothing here assumes the change is live. A Google refusal (a release in review, an invalid
 * transition) is relayed as `store_refused` with the status only.
 *
 * Every control first resolves the setup (`setup.ts`): while the `google-service-account`
 * credential is not pinned to the package the manifest names (P5-02f's pin), each answers 409
 * `credential_pin_missing` / `credential_pin_mismatch` before any token is minted or request sent.
 *
 * `applyPlayControl` is the single halt path: the vitals auto-halt (`vitals.ts`, actor
 * `connector:play-vitals`) and the telemetry auto-halt P6-03 adds call it too.
 *
 * A-18e: a console control first takes the package's EDIT LEASE (`lease.ts`, purpose `control`)
 * and answers 409 `edit_lease_held` while anyone else holds it (a provisioning run's edit), before
 * any token is minted: the control's own edit would invalidate theirs. The vitals auto-halt runs
 * inside the poll tick, under the poll's lease. Both commit with the gate context
 * `PLAY_ROLLOUT_CONTROL` (`core/storefront/rules/googlePlay.ts`): P5-03's rollout controls keep
 * their own confirmations (`confirmRollback`) and are not typed by the storefront gate.
 */

import type { Db } from "../../../../db/types.js";
import type { Env } from "../../../../platform/env.js";
import type { ServiceHooks } from "../../../../core/hooks.js";
import { audit } from "../../../../core/console/audit.js";
import type { AdminSession } from "../../../../core/console/session.js";
import { getRollout, rolloutRecord } from "../../rollouts.js";
import type { ConnectorControl } from "../index.js";
import { auditConnector } from "../state.js";
import { PLAY_ROLLOUT_CONTROL, PlayError, type FetchImpl } from "./client.js";
import {
  isPriority,
  parseTrack,
  planControl,
  policyPriority,
  type PlayControlVerb,
  type PlayRelease,
  type PlayTrack,
} from "./map.js";
import {
  patchPlaySettings,
  readPlaySettings,
  writePlaySettings,
} from "./policy.js";
import { releaseOf, resolveVersionCodes, syncPlay } from "./poll.js";
import {
  acquirePlayEditLease,
  isLeaseHeld,
  releasePlayEditLease,
} from "./lease.js";
import { finishRun, playRun, type PlayRun } from "./run.js";
import { isPinReason, PLAY_TRACK, resolvePlaySetup } from "./setup.js";

export interface ControlContext {
  env: Env;
  db: Db;
  product: string;
  hooks: ServiceHooks;
  now: number;
  session: AdminSession;
  origin: string;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
}

export type ControlResult =
  | { ok: true; [k: string]: unknown }
  | {
      ok: false;
      status: 404 | 409 | 422 | 502;
      reason: string;
      message: string;
      fields?: string[];
    };

const refuse = (
  status: 404 | 409 | 422 | 502,
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

/** Who a change is attributed to: an operator's session, or an automatic halt (its source). */
export type PlayActor =
  | { kind: "admin"; session: AdminSession }
  | { kind: "system"; source: string; label: string };

export interface PlayControlRequest {
  verb: PlayControlVerb;
  track: string;
  /** Exactly one of these names the release on the track. */
  versionCode?: string;
  releaseId?: string;
  userFraction?: number;
  /** `priority`, or `fraction` on a draft without one: the priority to set. Omitted → policy. */
  priority?: number;
  confirmRollback?: boolean;
  actor: PlayActor;
  /** Appended to the audit summary (the vitals reading that tripped a halt). */
  reason?: string;
}

const VERB_PAST: Record<PlayControlVerb, string> = {
  fraction: "Set the fraction of",
  halt: "Halted",
  resume: "Resumed",
  complete: "Completed",
  priority: "Set the in-app update priority of",
};

/**
 * The policy priority for a release about to start on `track`: from Release's channel policy
 * for the channel the track is mapped to (`critical`, `minSupported`), the version the track
 * serves now (its completed release), and the operator's default.
 */
async function policyFor(
  run: PlayRun,
  track: PlayTrack,
  target: PlayRelease,
): Promise<{ priority: number; reason: string }> {
  const settings = await readPlaySettings(run.db, run.product);
  const codes = new Set(track.releases.flatMap((r) => r.versionCodes));
  const resolved = await resolveVersionCodes(run.hooks, codes);
  const release = releaseOf(target, resolved);
  const served = track.releases.find((r) => r.status === "completed");
  const servedRelease = served ? releaseOf(served, resolved) : null;
  const channel = run.setup.routes.get(track.track)?.[0]?.channel ?? null;
  const catalog = run.hooks.releaseCatalog();
  const policy =
    catalog && release && channel
      ? (await catalog.channelPolicies(release.deliverableId)).find(
          (p) => p.channel === channel,
        )
      : undefined;
  return policyPriority({
    critical: policy?.critical ?? false,
    minSupported: policy?.minSupported ?? null,
    servedVersion: servedRelease?.version ?? null,
    defaultPriority: settings.priority.default,
  });
}

/**
 * Apply one control to one release in one edit, audit it, re-read. Throws `PlayError` when
 * Google refuses (the edit is deleted first); answers a refusal for anything decided before the
 * PATCH (no audit row, nothing sent but the edit's own insert/get/delete).
 */
export async function applyPlayControl(
  run: PlayRun,
  req: PlayControlRequest,
): Promise<ControlResult> {
  if (!PLAY_TRACK.test(req.track))
    return refuse(422, "invalid_body", "track must be a Play track id", [
      "track",
    ]);
  if ((req.versionCode === undefined) === (req.releaseId === undefined))
    return refuse(
      422,
      "invalid_body",
      "give exactly one of versionCode or releaseId",
      ["versionCode", "releaseId"],
    );

  const editId = await run.publisher.insertEdit();
  let committed = false;
  let plan: Extract<ReturnType<typeof planControl>, { ok: true }>;
  let target: PlayRelease;
  let priorityReason: string | null = null;
  try {
    const track = parseTrack(await run.publisher.getTrack(editId, req.track));
    if (!track)
      return refuse(404, "unknown_track", `Play has no track ${req.track}`);
    let index = -1;
    if (req.versionCode !== undefined) {
      index = track.releases.findIndex((r) =>
        r.versionCodes.includes(req.versionCode!),
      );
    } else {
      const resolved = await resolveVersionCodes(
        run.hooks,
        new Set(track.releases.flatMap((r) => r.versionCodes)),
      );
      index = track.releases.findIndex(
        (r) => releaseOf(r, resolved)?.releaseId === req.releaseId,
      );
    }
    if (index < 0)
      return refuse(
        404,
        "unknown_release",
        `no release on track ${req.track} carries ${
          req.versionCode !== undefined
            ? `version code ${req.versionCode}`
            : req.releaseId
        }`,
      );
    target = track.releases[index]!;
    let priority = req.priority;
    const needsPolicy =
      priority === undefined &&
      ((req.verb === "fraction" &&
        target.status === "draft" &&
        target.inAppUpdatePriority === null) ||
        (req.verb === "priority" && target.status === "draft"));
    if (needsPolicy) {
      const p = await policyFor(run, track, target);
      priority = p.priority;
      priorityReason = p.reason;
    }
    const planned = planControl({
      verb: req.verb,
      releases: track.releases,
      target: index,
      ...(req.userFraction !== undefined
        ? { userFraction: req.userFraction }
        : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(req.confirmRollback !== undefined
        ? { confirmRollback: req.confirmRollback }
        : {}),
    });
    if (!planned.ok)
      return refuse(planned.status, planned.reason, planned.message);
    plan = planned;
    await run.publisher.patchTrack(
      editId,
      req.track,
      { track: req.track, releases: plan.releases },
      PLAY_ROLLOUT_CONTROL,
    );
    await run.publisher.commitEdit(editId, PLAY_ROLLOUT_CONTROL);
    committed = true;
  } finally {
    if (!committed) await run.publisher.deleteEdit(editId);
  }

  const codes = target.versionCodes.join(", ");
  const what = `the Google Play release ${target.name ?? `(versionCodes ${codes})`}${
    target.name ? ` (versionCodes ${codes})` : ""
  } on track ${req.track}`;
  const summary =
    `${VERB_PAST[req.verb]} ${what}` +
    (req.verb === "fraction"
      ? ` to ${(req.userFraction! * 100).toFixed(2)}%`
      : "") +
    (plan.prioritySet !== null
      ? ` with inAppUpdatePriority ${plan.prioritySet}${priorityReason ? ` (${priorityReason})` : ""}`
      : "") +
    (plan.rollback
      ? "; Play rolls the track back to the previously completed release"
      : "") +
    (req.reason ? ` — ${req.reason}` : "");
  const action = `distribution.play.${req.verb}`;
  const target_ = {
    kind: "play",
    id: `${req.track}:${target.versionCodes.join(",")}`,
  };
  if (req.actor.kind === "admin")
    await audit(
      run.db,
      run.product,
      req.actor.session,
      run.now,
      action,
      target_,
      summary,
    );
  else
    await auditConnector(
      { db: run.db, product: run.product, now: run.now },
      req.actor.source,
      req.actor.label,
      action,
      target_,
      summary,
    );

  // Re-read: what the console shows afterwards is Play's answer, not the request's intent. A
  // re-read that fails does not undo a committed change; the next tick reads again.
  let reread: PlayTrack | null = null;
  try {
    const synced = await syncPlay(run);
    reread = synced.tracks.find((t) => t.track === req.track) ?? null;
  } catch {
    reread = null;
  }
  const rollouts = [];
  for (const route of run.setup.routes.get(req.track) ?? []) {
    const row = await run.db.first<{ deliverable_id: string }>(
      `SELECT deliverable_id FROM dist_rollouts
        WHERE product = ? AND outlet_id = ? AND channel = ? AND mirrored = 1`,
      run.product,
      route.outletId,
      route.channel,
    );
    const r = row
      ? await getRollout(
          run.db,
          run.product,
          row.deliverable_id,
          route.outletId,
          route.channel,
        )
      : null;
    if (r) rollouts.push(rolloutRecord(r));
  }
  return {
    ok: true,
    track: req.track,
    versionCodes: target.versionCodes,
    requested: plan.to,
    prioritySet: plan.prioritySet,
    rollback: plan.rollback,
    reread: reread
      ? reread.releases.map((r) => ({
          name: r.name,
          versionCodes: r.versionCodes,
          status: r.status,
          userFraction: r.userFraction,
          inAppUpdatePriority: r.inAppUpdatePriority,
        }))
      : null,
    rollouts,
    note: "Play can take a while to propagate a committed change; the mirror shows what Play answers on each read.",
  };
}

// ── The console controls ─────────────────────────────────────────────────────────────────────

/** Run `fn` against a fresh connector run; Google's refusals become `store_refused`. */
async function withRun(
  c: ControlContext,
  fn: (run: PlayRun) => Promise<ControlResult>,
): Promise<ControlResult> {
  const { setup, inert } = await resolvePlaySetup(c.env, c.db, c.product);
  if (!setup) {
    // The operator's pin and the manifest disagree (or there is no pin): refuse with the reason,
    // before any token is minted or any request is sent — a halt, a ramp or a completion aimed at
    // an app the operator did not choose is exactly what the pin exists to stop.
    if (isPinReason(inert.reason))
      return refuse(409, `credential_${inert.reason}`, inert.message);
    return refuse(
      404,
      "not_configured",
      "Google Play is not configured: declare a play or play-testing outlet with a packageName and tracks, and store a google-service-account credential pinned to that package",
    );
  }
  // The edit lease (A-18e), before any token: a control's edit would invalidate a held one.
  const lease = await acquirePlayEditLease(c.db, {
    packageName: setup.packageName,
    purpose: "control",
    actor: `admin:${c.session.sub}`,
  });
  if (isLeaseHeld(lease))
    return refuse(
      409,
      "edit_lease_held",
      `Google Play is busy: a ${lease.purpose} edit holds this app's edit lease until ${new Date(
        lease.expiresAt * 1000,
      ).toISOString()}; try again then`,
    );
  const run = playRun({
    env: c.env,
    db: c.db,
    product: c.product,
    hooks: c.hooks,
    now: c.now,
    setup,
    use: "play:control",
    ...(c.fetchImpl ? { fetchImpl: c.fetchImpl } : {}),
    ...(c.sleep ? { sleep: c.sleep } : {}),
  });
  let error: unknown = null;
  try {
    return await fn(run);
  } catch (e) {
    error = e;
    if (e instanceof PlayError)
      return refuse(
        e.status === 404
          ? 404
          : e.status >= 500 || e.status === 429
            ? 502
            : 409,
        "store_refused",
        e.message,
      );
    throw e;
  } finally {
    await releasePlayEditLease(c.db, lease);
    await finishRun(run, error);
  }
}

const VERSION_CODE = /^[1-9][0-9]{0,18}$/;

/** The request fields shared by the rollout controls and `priority`, validated. */
function releaseRequest(
  body: Record<string, unknown>,
):
  | Pick<PlayControlRequest, "track" | "versionCode" | "releaseId">
  | ControlResult {
  if (typeof body.track !== "string" || !PLAY_TRACK.test(body.track))
    return refuse(422, "invalid_body", "track must be a Play track id", [
      "track",
    ]);
  const vc = body.versionCode;
  const versionCode =
    typeof vc === "number" && Number.isSafeInteger(vc) ? String(vc) : vc;
  if (
    versionCode !== undefined &&
    (typeof versionCode !== "string" || !VERSION_CODE.test(versionCode))
  )
    return refuse(422, "invalid_body", "versionCode must be a version code", [
      "versionCode",
    ]);
  if (
    body.releaseId !== undefined &&
    (typeof body.releaseId !== "string" || body.releaseId === "")
  )
    return refuse(422, "invalid_body", "releaseId must be a release id", [
      "releaseId",
    ]);
  if ((versionCode === undefined) === (body.releaseId === undefined))
    return refuse(
      422,
      "invalid_body",
      "give exactly one of versionCode or releaseId",
      ["versionCode", "releaseId"],
    );
  return {
    track: body.track,
    ...(versionCode !== undefined
      ? { versionCode: versionCode as string }
      : {}),
    ...(body.releaseId !== undefined
      ? { releaseId: body.releaseId as string }
      : {}),
  };
}

function isRefusal(v: unknown): v is Extract<ControlResult, { ok: false }> {
  return (
    typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false
  );
}

function rolloutControl(
  verb: Exclude<PlayControlVerb, "priority">,
): ConnectorControl {
  return (c, body) => {
    const sel = releaseRequest(body);
    if (isRefusal(sel)) return Promise.resolve(sel);
    if (verb === "fraction") {
      const f = body.userFraction;
      if (typeof f !== "number" || !(f > 0 && f < 1))
        return Promise.resolve(
          refuse(
            422,
            "invalid_body",
            "userFraction must be a number strictly between 0 and 1",
            ["userFraction"],
          ),
        );
    }
    if (body.priority !== undefined && !isPriority(body.priority))
      return Promise.resolve(
        refuse(422, "invalid_body", "priority must be 0 to 5", ["priority"]),
      );
    if (
      body.confirmRollback !== undefined &&
      typeof body.confirmRollback !== "boolean"
    )
      return Promise.resolve(
        refuse(422, "invalid_body", "confirmRollback must be a boolean", [
          "confirmRollback",
        ]),
      );
    return withRun(c, (run) =>
      applyPlayControl(run, {
        verb,
        ...(sel as Pick<
          PlayControlRequest,
          "track" | "versionCode" | "releaseId"
        >),
        ...(verb === "fraction"
          ? { userFraction: body.userFraction as number }
          : {}),
        ...(verb === "fraction" && body.priority !== undefined
          ? { priority: body.priority as number }
          : {}),
        ...(verb === "halt" && body.confirmRollback !== undefined
          ? { confirmRollback: body.confirmRollback as boolean }
          : {}),
        actor: { kind: "admin", session: c.session },
      }),
    );
  };
}

const priorityControl: ConnectorControl = (c, body) => {
  const sel = releaseRequest(body);
  if (isRefusal(sel)) return Promise.resolve(sel);
  if (body.priority !== undefined && !isPriority(body.priority))
    return Promise.resolve(
      refuse(422, "invalid_body", "priority must be 0 to 5", ["priority"]),
    );
  return withRun(c, (run) =>
    applyPlayControl(run, {
      verb: "priority",
      ...(sel as Pick<
        PlayControlRequest,
        "track" | "versionCode" | "releaseId"
      >),
      ...(body.priority !== undefined
        ? { priority: body.priority as number }
        : {}),
      actor: { kind: "admin", session: c.session },
    }),
  );
};

/**
 * The operator's settings: validated, merged over the stored ones, audited. No Play call. Refused
 * like every other control while the credential's pin is missing or names another package: the
 * settings (the vitals auto-halt above all) are for the app the operator pinned, so they wait
 * until the pin and the manifest agree. With no outlet or credential yet they can be set ahead.
 */
const settingsControl: ConnectorControl = async (c, body) => {
  const { inert } = await resolvePlaySetup(c.env, c.db, c.product);
  if (inert && isPinReason(inert.reason))
    return refuse(409, `credential_${inert.reason}`, inert.message);
  const current = await readPlaySettings(c.db, c.product);
  const patched = patchPlaySettings(current, body);
  if (!patched.ok)
    return refuse(422, "invalid_body", patched.message, [patched.field]);
  await writePlaySettings(
    c.db,
    c.product,
    patched.settings,
    c.session.sub,
    c.now,
  );
  const v = patched.settings.vitals;
  await audit(
    c.db,
    c.product,
    c.session,
    c.now,
    "distribution.play.settings",
    { kind: "play", id: "settings" },
    `Set the Google Play connector settings: default in-app update priority ${patched.settings.priority.default}; vitals auto-halt ${
      v.enabled
        ? `on (${v.metric}, ${v.windowHours} h, at least ${v.minDistinctUsers} users, crash > ${v.crashRateThreshold}, ANR > ${v.anrRateThreshold})`
        : "off"
    }`,
  );
  return { ok: true, settings: patched.settings };
};

export const PLAY_CONTROLS: Readonly<Record<string, ConnectorControl>> = {
  "rollout/fraction": rolloutControl("fraction"),
  "rollout/halt": rolloutControl("halt"),
  "rollout/resume": rolloutControl("resume"),
  "rollout/complete": rolloutControl("complete"),
  priority: priorityControl,
  settings: settingsControl,
};
