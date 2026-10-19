/// <reference types="@cloudflare/workers-types" />

/**
 * Notification destinations (ST-27): where an operator alert goes.
 *
 * An alert is a platform event an operator should hear about: an auto-halt that tripped, a store
 * connection that stopped working, a purchase that maps to nothing, a change of who may do what.
 * Until ST-27 they reached the audit trail only. A destination is an email address (mailed
 * through Core's one send choke point, `emailDelivery.ts`, from the platform sender) or an https
 * webhook (signed, `alertWebhook.ts`). There is no new email path.
 *
 * ── SCOPES AND THE OVERRIDE ─────────────────────────────────────────────────────────────────
 *
 * `product = '_platform'` is the platform's destination; a product slug is that product's. For
 * one alert kind of one product, the product's enabled destinations that take the kind REPLACE
 * the platform's; with none, the platform's apply. An alert with no product (a platform event)
 * goes to the platform's alone.
 *
 * ── WHAT IS SEALED ──────────────────────────────────────────────────────────────────────────
 *
 * A webhook URL can carry a token in its path, so the URL and the signing secret are sealed
 * together (`{url, secret}`, AAD `pkey:v2:<scope>:notify-destination:<id>`) in
 * `notify_destination_secrets`. `notify_destinations.target` holds only what a list may show: an
 * address, or `https://host/…`. Nothing here returns the URL or the secret after the write that
 * set it; the secret is returned once, by `create` and `rotate`. Audit rows name the kind, the
 * host and the alert kinds, never a URL path or a secret.
 *
 * ── LIMITS ──────────────────────────────────────────────────────────────────────────────────
 *
 * At most `MAX_DESTINATIONS_PER_SCOPE` per scope. Delivery never throws and never fails the
 * event that raised the alert. A destination that fails `FAILING_AFTER` times in a row raises a
 * `notifications_failing` alert to the OTHER destinations; if none takes it, the audit row
 * `notify.alert.undeliverable` is the record.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { randomId } from "../../platform/crypto.js";
import { open, seal, type SealContext } from "../../platform/keyvault.js";
import { appendAudit } from "../audit.js";
import { appendPlatformEvent } from "../ops/platformEvents.js";
import { strictEmail } from "../strictEmail.js";
import { deliverEmail } from "./emailDelivery.js";
import { emailAssetOrigin, renderEmail } from "./render.js";
import { displayValue } from "./templates.js";
import {
  newWebhookSecret,
  normaliseWebhookUrl,
  postWebhook,
  webhookDisplay,
  webhookUrlProblem,
  type WebhookDeps,
} from "./alertWebhook.js";

/** The alert kinds a destination can take. */
export const ALERT_KINDS = [
  "auto_halt",
  "store_connection",
  "commerce",
  "access_changed",
  "notifications_failing",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** What an operator reads in the console for each kind. */
export const ALERT_KIND_LABELS: Readonly<Record<AlertKind, string>> = {
  auto_halt: "Auto-halt tripped",
  store_connection: "Store connection failing",
  commerce: "Commerce problem",
  access_changed: "Access changed",
  notifications_failing: "A destination is failing",
};

export const PLATFORM_SCOPE = "_platform";
export const MAX_DESTINATIONS_PER_SCOPE = 5;
/** Consecutive failures before `notifications_failing` is raised. */
export const FAILING_AFTER = 3;
/** The least seconds between two test sends to one destination. */
export const TEST_INTERVAL_SECONDS = 30;
const LABEL_MAX = 64;
const FAILURES_CAP = 1000;

export type DestinationKind = "email" | "webhook";

export interface Actor {
  sub: string | null;
  name: string | null;
  email: string | null;
}

/** A destination as a caller may see it: never a URL, never a secret. */
export interface DestinationView {
  id: string;
  scope: string;
  kind: DestinationKind;
  /** The address, or `https://host/…`. */
  target: string;
  label: string | null;
  alerts: AlertKind[];
  enabled: boolean;
  version: number;
  lastStatus: "ok" | "failed" | "refused" | null;
  lastAt: number | null;
  failures: number;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
}

interface Row {
  id: string;
  product: string;
  kind: DestinationKind;
  target: string;
  label: string | null;
  alerts_json: string;
  enabled: number;
  version: number;
  created_at: number;
  created_by: string;
  updated_at: number;
  updated_by: string;
  last_status: string | null;
  last_at: number | null;
  failures: number;
}

const COLUMNS =
  "id, product, kind, target, label, alerts_json, enabled, version, created_at, created_by, updated_at, updated_by, last_status, last_at, failures";

export type Failure = {
  ok: false;
  status: 400 | 404 | 409 | 422 | 429;
  reason: string;
  message: string;
};

function fail(
  status: Failure["status"],
  reason: string,
  message: string,
): Failure {
  return { ok: false, status, reason, message };
}

function alertsOf(json: string): AlertKind[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v)
      ? ALERT_KINDS.filter((k) => (v as unknown[]).includes(k))
      : [];
  } catch {
    return [];
  }
}

function view(r: Row): DestinationView {
  return {
    id: r.id,
    scope: r.product,
    kind: r.kind,
    target: r.target,
    label: r.label,
    alerts: alertsOf(r.alerts_json),
    enabled: r.enabled === 1,
    version: r.version,
    lastStatus:
      r.last_status === "ok" ||
      r.last_status === "failed" ||
      r.last_status === "refused"
        ? r.last_status
        : null,
    lastAt: r.last_at,
    failures: r.failures,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function ctx(scope: string, id: string): SealContext {
  return { product: scope, kind: "notify-destination", id };
}

interface SealedPayload {
  url: string;
  secret: string;
}

async function sealPayload(
  env: Env,
  scope: string,
  id: string,
  p: SealedPayload,
): Promise<string> {
  return seal(env, JSON.stringify(p), ctx(scope, id));
}

async function openPayload(
  env: Env,
  db: Db,
  scope: string,
  id: string,
): Promise<SealedPayload | null> {
  const row = await db.first<{ enc_secret_json: string }>(
    "SELECT enc_secret_json FROM notify_destination_secrets WHERE product = ? AND destination_id = ?",
    scope,
    id,
  );
  if (!row) return null;
  try {
    const v = JSON.parse(await open(env, row.enc_secret_json, ctx(scope, id)));
    return typeof v?.url === "string" && typeof v?.secret === "string"
      ? { url: v.url, secret: v.secret }
      : null;
  } catch {
    return null;
  }
}

// ── Audit ────────────────────────────────────────────────────────────────────────────────────

async function record(
  db: Db,
  scope: string,
  actor: Actor,
  now: number,
  action: string,
  id: string,
  summary: string,
  before?: unknown,
  after?: unknown,
): Promise<void> {
  if (scope === PLATFORM_SCOPE) {
    await appendPlatformEvent(db, {
      actor: { ...actor, sub: actor.sub ?? "system:notify" },
      at: now,
      action,
      target: { kind: "notify-destination", id },
      summary,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    });
    return;
  }
  await appendAudit(db, {
    product: scope,
    at: now,
    actor_sub: actor.sub,
    actor_name: actor.name,
    actor_email: actor.email,
    action,
    target_kind: "notify-destination",
    target_id: id,
    parent_id: null,
    summary,
    before_json: before === undefined ? null : JSON.stringify(before),
    after_json: after === undefined ? null : JSON.stringify(after),
  });
}

/** What an audit row may hold of a destination: the same as a list shows. */
function auditShape(v: DestinationView): unknown {
  return {
    kind: v.kind,
    target: v.target,
    label: v.label,
    alerts: v.alerts,
    enabled: v.enabled,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────

export async function listDestinations(
  db: Db,
  scope: string,
): Promise<DestinationView[]> {
  const rows = await db.all<Row>(
    `SELECT ${COLUMNS} FROM notify_destinations WHERE product = ? ORDER BY created_at, id`,
    scope,
  );
  return rows.map(view);
}

async function getRow(db: Db, scope: string, id: string): Promise<Row | null> {
  return db.first<Row>(
    `SELECT ${COLUMNS} FROM notify_destinations WHERE product = ? AND id = ?`,
    scope,
    id,
  );
}

// ── Writes ───────────────────────────────────────────────────────────────────────────────────

export interface DestinationInput {
  kind?: unknown;
  /** An email address, or an https URL for a webhook. */
  target?: unknown;
  label?: unknown;
  alerts?: unknown;
  enabled?: unknown;
}

function parseAlerts(raw: unknown): AlertKind[] | Failure {
  if (!Array.isArray(raw) || raw.length === 0)
    return fail(422, "alerts_required", "Pick at least one alert.");
  const out: AlertKind[] = [];
  for (const k of raw) {
    if (!ALERT_KINDS.includes(k as AlertKind))
      return fail(422, "alert_unknown", "That alert is not one of the kinds.");
    if (!out.includes(k as AlertKind)) out.push(k as AlertKind);
  }
  return ALERT_KINDS.filter((k) => out.includes(k));
}

function parseLabel(raw: unknown): string | null | Failure {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string")
    return fail(422, "label_invalid", "The label is text.");
  const label = displayValue(raw, "");
  if (label === "" || Array.from(raw.trim()).length > LABEL_MAX)
    return fail(
      422,
      "label_invalid",
      `The label is up to ${LABEL_MAX} characters.`,
    );
  return label;
}

/** A target for `kind`: the stored form and what a list shows. */
function parseTarget(
  kind: DestinationKind,
  raw: unknown,
): { stored: string; shown: string } | Failure {
  if (kind === "email") {
    const email = strictEmail(raw);
    if (email === null)
      return fail(422, "target_invalid", "Enter a valid email address.");
    return { stored: email, shown: email };
  }
  const problem = webhookUrlProblem(raw);
  if (problem !== null)
    return fail(
      422,
      "url_refused",
      problem === "https-only"
        ? "A webhook URL must start with https://."
        : "That URL cannot be used. It must be a public https address.",
    );
  const stored = normaliseWebhookUrl(raw as string);
  return { stored, shown: webhookDisplay(stored) };
}

export type Written =
  | { ok: true; destination: DestinationView; secret?: string }
  | Failure;

export async function createDestination(
  env: Env,
  db: Db,
  scope: string,
  actor: Actor,
  input: DestinationInput,
  now: number,
): Promise<Written> {
  const kind = input.kind;
  if (kind !== "email" && kind !== "webhook")
    return fail(
      422,
      "kind_invalid",
      "The destination is an email or a webhook.",
    );
  const target = parseTarget(kind, input.target);
  if ("ok" in target) return target;
  const alerts = parseAlerts(input.alerts);
  if (!Array.isArray(alerts)) return alerts;
  const label = parseLabel(input.label);
  if (typeof label === "object" && label !== null) return label;
  const count = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM notify_destinations WHERE product = ?",
    scope,
  );
  if ((count?.n ?? 0) >= MAX_DESTINATIONS_PER_SCOPE)
    return fail(
      409,
      "too_many",
      `Up to ${MAX_DESTINATIONS_PER_SCOPE} destinations. Remove one first.`,
    );
  const id = randomId("dst");
  let secret: string | undefined;
  const statements = [
    {
      sql: `INSERT INTO notify_destinations
              (id, product, kind, target, label, alerts_json, enabled, version, created_at, created_by, updated_at, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
      params: [
        id,
        scope,
        kind,
        target.shown,
        label as string | null,
        JSON.stringify(alerts),
        now,
        actor.sub ?? "system",
        now,
        actor.sub ?? "system",
      ],
    },
  ];
  if (kind === "webhook") {
    secret = newWebhookSecret();
    statements.push({
      sql: "INSERT INTO notify_destination_secrets (product, destination_id, enc_secret_json) VALUES (?, ?, ?)",
      params: [
        scope,
        id,
        await sealPayload(env, scope, id, { url: target.stored, secret }),
      ],
    });
  }
  await db.batch(statements);
  const created = view((await getRow(db, scope, id))!);
  await record(
    db,
    scope,
    actor,
    now,
    "notify.destination.create",
    id,
    `Added a ${kind} alert destination (${target.shown})`,
    undefined,
    auditShape(created),
  );
  return { ok: true, destination: created, ...(secret ? { secret } : {}) };
}

export interface DestinationPatch extends DestinationInput {
  expectedVersion?: unknown;
  /** True: issue a new signing secret (a webhook only). */
  rotateSecret?: unknown;
}

export async function updateDestination(
  env: Env,
  db: Db,
  scope: string,
  actor: Actor,
  id: string,
  patch: DestinationPatch,
  now: number,
): Promise<Written> {
  const row = await getRow(db, scope, id);
  if (!row) return fail(404, "not_found", "No such destination.");
  const before = view(row);
  if (
    patch.expectedVersion !== undefined &&
    patch.expectedVersion !== row.version
  )
    return fail(409, "stale", "Changed elsewhere. Reload and try again.");
  let target = { stored: "", shown: row.target };
  let retarget = false;
  if (patch.target !== undefined) {
    const t = parseTarget(row.kind, patch.target);
    if ("ok" in t) return t;
    target = t;
    retarget = true;
  }
  let alerts = alertsOf(row.alerts_json);
  if (patch.alerts !== undefined) {
    const a = parseAlerts(patch.alerts);
    if (!Array.isArray(a)) return a;
    alerts = a;
  }
  let label = row.label;
  if (patch.label !== undefined) {
    const l = parseLabel(patch.label);
    if (typeof l === "object" && l !== null) return l;
    label = l;
  }
  let enabled = row.enabled;
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean")
      return fail(422, "enabled_invalid", "Enabled is true or false.");
    enabled = patch.enabled ? 1 : 0;
  }
  const rotate = patch.rotateSecret === true;
  if (
    patch.rotateSecret !== undefined &&
    typeof patch.rotateSecret !== "boolean"
  )
    return fail(422, "rotate_invalid", "Rotate is true or false.");
  if (rotate && row.kind !== "webhook")
    return fail(422, "rotate_invalid", "Only a webhook has a secret.");

  let secret: string | undefined;
  const statements = [
    {
      sql: `UPDATE notify_destinations
               SET target = ?, label = ?, alerts_json = ?, enabled = ?, version = version + 1,
                   updated_at = ?, updated_by = ?
             WHERE product = ? AND id = ? AND version = ?`,
      params: [
        target.shown,
        label,
        JSON.stringify(alerts),
        enabled,
        now,
        actor.sub ?? "system",
        scope,
        id,
        row.version,
      ],
    },
  ];
  if (row.kind === "webhook" && (retarget || rotate)) {
    const current = await openPayload(env, db, scope, id);
    if (!current && !retarget)
      return fail(
        409,
        "secret_unreadable",
        "Enter the URL again to repair it.",
      );
    secret = rotate || !current ? newWebhookSecret() : current.secret;
    const blob = await sealPayload(env, scope, id, {
      url: retarget ? target.stored : current!.url,
      secret,
    });
    statements.push({
      sql: `INSERT INTO notify_destination_secrets (product, destination_id, enc_secret_json) VALUES (?, ?, ?)
            ON CONFLICT(product, destination_id) DO UPDATE SET enc_secret_json = excluded.enc_secret_json`,
      params: [scope, id, blob],
    });
    // A new URL is a new endpoint: it starts with a clean record.
    if (retarget)
      statements.push({
        sql: "UPDATE notify_destinations SET last_status = NULL, last_at = NULL, failures = 0 WHERE product = ? AND id = ?",
        params: [scope, id],
      });
  }
  // The version guard is on the first statement only; run it alone first so a lost race writes
  // nothing of the sealed row.
  const changed = await db.runChanges(
    statements[0]!.sql,
    ...statements[0]!.params,
  );
  if (changed === 0)
    return fail(409, "stale", "Changed elsewhere. Reload and try again.");
  for (const s of statements.slice(1)) await db.run(s.sql, ...s.params);
  const after = view((await getRow(db, scope, id))!);
  await record(
    db,
    scope,
    actor,
    now,
    rotate ? "notify.destination.rotate" : "notify.destination.update",
    id,
    rotate
      ? `Issued a new signing secret for an alert webhook (${after.target})`
      : `Changed an alert destination (${after.target})`,
    auditShape(before),
    auditShape(after),
  );
  return {
    ok: true,
    destination: after,
    ...(secret && rotate ? { secret } : {}),
  };
}

export async function deleteDestination(
  db: Db,
  scope: string,
  actor: Actor,
  id: string,
  expectedVersion: unknown,
  now: number,
): Promise<{ ok: true } | Failure> {
  const row = await getRow(db, scope, id);
  if (!row) return fail(404, "not_found", "No such destination.");
  if (expectedVersion !== undefined && expectedVersion !== row.version)
    return fail(409, "stale", "Changed elsewhere. Reload and try again.");
  const n = await db.runChanges(
    "DELETE FROM notify_destinations WHERE product = ? AND id = ? AND version = ?",
    scope,
    id,
    row.version,
  );
  if (n === 0)
    return fail(409, "stale", "Changed elsewhere. Reload and try again.");
  await db.run(
    "DELETE FROM notify_destination_secrets WHERE product = ? AND destination_id = ?",
    scope,
    id,
  );
  await record(
    db,
    scope,
    actor,
    now,
    "notify.destination.delete",
    id,
    `Removed an alert destination (${row.target})`,
    auditShape(view(row)),
  );
  return { ok: true };
}

// ── Delivery ─────────────────────────────────────────────────────────────────────────────────

export interface Alert {
  kind: AlertKind;
  /** The product the alert is about, or null for a platform event. */
  product: string | null;
  title: string;
  detail: string;
}

export interface AlertDeps extends WebhookDeps {
  /** Test seam: replaces the email send. */
  sendEmail?: (
    to: string,
    subject: string,
    text: string,
    html: string,
  ) => Promise<boolean>;
}

function clip(s: string, n: number): string {
  return Array.from(s).slice(0, n).join("");
}

function alertMessage(env: Env, a: Alert, productName: string | null) {
  const title = displayValue(a.title, ALERT_KIND_LABELS[a.kind]);
  const detail = clip(a.detail, 500);
  const subject = `Alert: ${title}`;
  const where = productName ? `Product: ${productName}` : "Platform";
  return {
    subject,
    text: `${title}\n\n${detail}\n\n${where}\n\nYou get this because this address is an alert destination in Polaris Key.`,
    html: renderEmail({
      subject,
      heading: title,
      paragraphs: [detail, where],
      footer:
        "You get this because this address is an alert destination in Polaris Key.",
      origin: emailAssetOrigin(env.CONSOLE_ORIGIN),
    }),
  };
}

function webhookPayload(a: Alert, now: number) {
  return {
    type: `alert.${a.kind}`,
    timestamp: new Date(now * 1000).toISOString(),
    data: {
      kind: a.kind,
      product: a.product,
      title: displayValue(a.title, ALERT_KIND_LABELS[a.kind]),
      detail: clip(a.detail, 500),
    },
  };
}

type Outcome = "ok" | "failed" | "refused";

async function deliverOne(
  env: Env,
  db: Db,
  row: Row,
  a: Alert,
  productName: string | null,
  now: number,
  deps: AlertDeps,
): Promise<Outcome> {
  try {
    if (row.kind === "email") {
      const m = alertMessage(env, a, productName);
      if (deps.sendEmail)
        return (await deps.sendEmail(row.target, m.subject, m.text, m.html))
          ? "ok"
          : "failed";
      const r = await deliverEmail(
        env,
        db,
        { sender: { kind: "platform" }, to: row.target, ...m },
        now,
      );
      return r.ok ? "ok" : "failed";
    }
    const p = await openPayload(env, db, row.product, row.id);
    if (!p) return "failed";
    return await postWebhook(
      p.url,
      p.secret,
      webhookPayload(a, now),
      now,
      deps,
    );
  } catch {
    return "failed";
  }
}

async function recordOutcome(
  db: Db,
  row: Row,
  outcome: Outcome,
  now: number,
): Promise<number> {
  try {
    await db.run(
      `UPDATE notify_destinations
          SET last_status = ?, last_at = ?, failures = ?
        WHERE product = ? AND id = ?`,
      outcome,
      now,
      outcome === "ok" ? 0 : Math.min(row.failures + 1, FAILURES_CAP),
      row.product,
      row.id,
    );
  } catch {
    // The record of an outcome never fails the alert.
  }
  return outcome === "ok" ? 0 : row.failures + 1;
}

/** The destinations an alert goes to: the product's override for this kind, else the platform's. */
export async function resolveDestinations(
  db: Db,
  kind: AlertKind,
  product: string | null,
): Promise<Row[]> {
  const takes = (r: Row): boolean =>
    r.enabled === 1 && alertsOf(r.alerts_json).includes(kind);
  if (product && product !== PLATFORM_SCOPE) {
    const own = (
      await db.all<Row>(
        `SELECT ${COLUMNS} FROM notify_destinations WHERE product = ? ORDER BY created_at, id`,
        product,
      )
    ).filter(takes);
    if (own.length > 0) return own;
  }
  return (
    await db.all<Row>(
      `SELECT ${COLUMNS} FROM notify_destinations WHERE product = ? ORDER BY created_at, id`,
      PLATFORM_SCOPE,
    )
  ).filter(takes);
}

export interface RaiseResult {
  /** How many destinations the alert was resolved to. */
  destinations: number;
  delivered: number;
}

/**
 * Tell the operator. Resolves the destinations, delivers to each and records each outcome. Never
 * throws: an alert is raised beside an event that has already happened. `exclude` keeps a
 * `notifications_failing` alert off the destination it is about.
 */
export async function raiseAlert(
  env: Env,
  db: Db,
  alert: Alert,
  now: number,
  deps: AlertDeps = {},
  exclude: readonly string[] = [],
): Promise<RaiseResult> {
  try {
    const rows = (
      await resolveDestinations(db, alert.kind, alert.product)
    ).filter((r) => !exclude.includes(r.id));
    if (rows.length === 0) return { destinations: 0, delivered: 0 };
    let productName: string | null = null;
    if (alert.product) {
      const p = await db.first<{ name: string | null }>(
        "SELECT name FROM products WHERE slug = ?",
        alert.product,
      );
      productName = displayValue(p?.name ?? alert.product, alert.product);
    }
    let delivered = 0;
    for (const row of rows) {
      const outcome = await deliverOne(
        env,
        db,
        row,
        alert,
        productName,
        now,
        deps,
      );
      const failures = await recordOutcome(db, row, outcome, now);
      if (outcome === "ok") delivered++;
      else if (
        failures === FAILING_AFTER &&
        alert.kind !== "notifications_failing"
      ) {
        await raiseAlert(
          env,
          db,
          {
            kind: "notifications_failing",
            product: row.product === PLATFORM_SCOPE ? null : row.product,
            title: "An alert destination is failing",
            detail: `${row.kind === "email" ? "The address" : "The webhook"} ${row.target} failed ${FAILING_AFTER} times in a row (${outcome}).`,
          },
          now,
          deps,
          [...exclude, row.id],
        );
      }
    }
    if (delivered === 0) {
      try {
        await record(
          db,
          alert.product ?? PLATFORM_SCOPE,
          { sub: null, name: "Polaris Key", email: null },
          now,
          "notify.alert.undeliverable",
          rows[0]!.id,
          `The ${alert.kind} alert reached none of its ${rows.length} destination(s)`,
        );
      } catch {
        // Never fails the event that raised the alert.
      }
    }
    return { destinations: rows.length, delivered };
  } catch {
    return { destinations: 0, delivered: 0 };
  }
}

/** Send one test alert to one destination. Throttled; the outcome is recorded like any other. */
export async function testDestination(
  env: Env,
  db: Db,
  scope: string,
  actor: Actor,
  id: string,
  now: number,
  deps: AlertDeps = {},
): Promise<{ ok: true; outcome: Outcome } | Failure> {
  const row = await getRow(db, scope, id);
  if (!row) return fail(404, "not_found", "No such destination.");
  if (row.last_at !== null && now - row.last_at < TEST_INTERVAL_SECONDS)
    return fail(
      429,
      "too_soon",
      "Wait a few seconds before sending another test.",
    );
  const alert: Alert = {
    kind: "notifications_failing",
    product: scope === PLATFORM_SCOPE ? null : scope,
    title: "Test alert",
    detail:
      "This is a test sent from the Polaris Key admin. Nothing needs doing.",
  };
  const productName = scope === PLATFORM_SCOPE ? null : scope;
  const outcome = await deliverOne(env, db, row, alert, productName, now, deps);
  await recordOutcome(db, row, outcome, now);
  await record(
    db,
    scope,
    actor,
    now,
    "notify.destination.test",
    id,
    `Sent a test alert to ${row.target} (${outcome})`,
  );
  return { ok: true, outcome };
}
