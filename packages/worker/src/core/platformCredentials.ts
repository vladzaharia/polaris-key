/// <reference types="@cloudflare/workers-types" />

/**
 * Platform store credentials (A-16; notes/S-13; owner decision 2026-10-04).
 *
 * One TEAM-LEVEL connection per store, held by the platform instead of by a product. For the App
 * Store that is the team's App Store Connect API key (it sees every app of the team) and the
 * team's In-App Purchase key (the App Store Server API of every app of the team); the Apple Team
 * ID is a non-secret setting beside them (`core/platformStoreSettings.ts`). Google Play (the
 * developer account's service account), the Microsoft Store (the seller's Partner Center app) and
 * Steam (the group's Web API publisher key) work the same way: one entry in `PLATFORM_CREDENTIALS`
 * names the outlet-credential kind whose validator and pin spec it reuses, and its Worker secret.
 *
 * What it is for: (1) listing every app the team key can see, with its distribution status, so a
 * platform admin can (2) assign an app to a product from a list instead of typing its id, and (3)
 * a product's connector falling back to the team key when the product has no credential of its
 * own. The rules, each enforced here rather than documented:
 *
 *   - **Two sources, in this precedence.** (a) The console-managed credential in
 *     `platform_credentials`, sealed under PLATFORM_KEK with the AAD
 *     `pkey:v2:_platform:platform-credential:<id>` (`_platform` cannot be a product slug, and the
 *     kind is its own, so the blob opens nowhere else); (b) a Worker secret (`secretName`: e.g.
 *     `PLATFORM_ASC_API_KEY`), JSON of the same shape, for ops bootstrap. The secret is
 *     read only when no ACTIVE console row exists. Both are re-validated on every open.
 *   - **The pin is the boundary.** A team key reaches every app of the team, so a product may use
 *     it only for the ONE app a platform admin assigned to it (`platform_credential_pins`: the
 *     product's `appleId` for the API key, its `bundleId` for the In-App Purchase key, its
 *     `packageName`, Store ID or Steam app id for the others). A product
 *     open REQUIRES the pin to match what the caller is about to act on — checked here, inside the
 *     custody owner, so no caller can forget it. No pin, no open. One product per app is a table
 *     constraint, so the team key can never be aimed at an app another product holds.
 *   - **Platform-admin writes only.** `putPlatformCredential`, `deletePlatformCredential`,
 *     `setPlatformPin` and `clearPlatformPin` are named only by this module and the Core admin
 *     handlers (`test/outletCredentialReach.test.ts`).
 *   - **One reader, audited.** `openPlatformCredential` is named only here, in
 *     `core/outletTokens.ts`, and in two reviewed Distribution files —
 *     `connectors/msstore/token.ts` (the Entra exchange) and `commerce/steam.ts` (the raw Steam
 *     key per call). Every call appends an audit row: to the product's `audit` for a product open
 *     (`platform_credential.use`), to `platform_audit` for a team-wide open (the apps listing).
 *     A token served from a memo or the sealed KV cache is not audited (by design, as for product
 *     credentials) — the pin is checked before every such hit.
 *   - **Never a value out.** Status reads presence and metadata (key id, issuer id, source); the
 *     sealed column and the `.p8` never leave this module except as a token minted from them.
 */

import type { Env } from "../env.js";
import type { Db, DbStatement } from "../db/types.js";
import { open, seal, type SealContext } from "../keyvault.js";
import { appendAudit } from "../repo.js";
import { randomId } from "../crypto.js";
import { sha256Hex } from "../platform/hash.js";
import {
  OUTLET_CREDENTIAL_ACTOR,
  validateOutletCredential,
  validateOutletCredentialPin,
  type OutletCredentialKind,
  type OutletCredentialMeta,
  type OutletCredentialValues,
} from "./outletCredentials.js";
import type { PlatformStore } from "./platformStoreSettings.js";
import {
  appendPlatformEvent,
  PLATFORM_SYSTEM_ACTOR,
  type PlatformEventActor,
} from "./platformEvents.js";

// ── the registry ─────────────────────────────────────────────────────────────────────────────

export {
  isPlatformStore,
  PLATFORM_STORES,
  type PlatformStore,
} from "./platformStoreSettings.js";

export interface PlatformCredentialSpec {
  store: PlatformStore;
  /** The slot within the store's connection (`api-key`, `in-app-purchase-key`, …). */
  slot: string;
  /** The outlet-credential kind whose validator and pin spec this slot reuses. */
  kind: OutletCredentialKind;
  label: string;
  /** The Worker secret consulted when no console credential is stored. */
  secretName: string;
  /** What a product's pin on this credential names (the outlet identity field it equals). */
  pinField: string;
}

/**
 * Every team-level credential slot. The first slot of a store is its PRIMARY credential: the
 * one the apps listing uses and the one an app assignment pins.
 */
export const PLATFORM_CREDENTIALS = {
  "app-store.api-key": {
    store: "app-store",
    slot: "api-key",
    kind: "asc-api-key",
    label: "App Store Connect API key (team)",
    secretName: "PLATFORM_ASC_API_KEY",
    pinField: "appleId",
  },
  "app-store.in-app-purchase-key": {
    store: "app-store",
    slot: "in-app-purchase-key",
    kind: "app-store-server-key",
    label: "In-App Purchase key (team, App Store Server API)",
    secretName: "PLATFORM_APP_STORE_SERVER_KEY",
    pinField: "bundleId",
  },
  "google-play.service-account": {
    store: "google-play",
    slot: "service-account",
    kind: "google-service-account",
    label: "Google Play service account (developer account)",
    secretName: "PLATFORM_GOOGLE_SERVICE_ACCOUNT",
    pinField: "packageName",
  },
  "microsoft-store.partner-center": {
    store: "microsoft-store",
    slot: "partner-center",
    kind: "ms-partner-center",
    label: "Partner Center app (seller account)",
    secretName: "PLATFORM_MS_PARTNER_CENTER",
    pinField: "productId",
  },
  "steam.publisher-key": {
    store: "steam",
    slot: "publisher-key",
    kind: "steam-publisher-key",
    label: "Steamworks Web API publisher key (group)",
    secretName: "PLATFORM_STEAM_PUBLISHER_KEY",
    pinField: "appId",
  },
} as const satisfies Record<string, PlatformCredentialSpec>;

export type PlatformCredentialId = keyof typeof PLATFORM_CREDENTIALS;

export const PLATFORM_CREDENTIAL_IDS = Object.keys(
  PLATFORM_CREDENTIALS,
) as PlatformCredentialId[];

/** A store's credential slots, primary first. */
export function platformCredentialsOf(
  store: PlatformStore,
): PlatformCredentialId[] {
  return PLATFORM_CREDENTIAL_IDS.filter(
    (id) => PLATFORM_CREDENTIALS[id].store === store,
  );
}

/** A store's primary credential: the one its apps listing uses and an assignment pins. */
export function primaryPlatformCredential(
  store: PlatformStore,
): PlatformCredentialId {
  return platformCredentialsOf(store)[0]!;
}

/** The credential id of a store's slot, or `null` for an unknown slot. */
export function platformCredentialBySlot(
  store: PlatformStore,
  slot: string,
): PlatformCredentialId | null {
  return (
    platformCredentialsOf(store).find(
      (id) => PLATFORM_CREDENTIALS[id].slot === slot,
    ) ?? null
  );
}

export function isPlatformCredentialId(v: unknown): v is PlatformCredentialId {
  return typeof v === "string" && Object.hasOwn(PLATFORM_CREDENTIALS, v);
}

/** The platform credential a product credential of `kind` falls back to, if any. */
export function platformCredentialForKind(
  kind: string,
): PlatformCredentialId | null {
  for (const id of PLATFORM_CREDENTIAL_IDS)
    if (PLATFORM_CREDENTIALS[id].kind === kind) return id;
  return null;
}

/**
 * A connector or commerce context that names its credential by a string id (P5-03, P5-04, P6-01)
 * names a platform credential by its HANDLE, `platform:<id>`. A `:` cannot appear in a product
 * credential id (`isOutletCredentialId`), so a handle never names a product credential.
 */
export function platformCredentialHandle(id: PlatformCredentialId): string {
  return `platform:${id}`;
}

/** The platform credential a handle names, or `null` for a product credential id. */
export function parsePlatformCredentialHandle(
  handle: string,
): PlatformCredentialId | null {
  if (!handle.startsWith("platform:")) return null;
  const id = handle.slice("platform:".length);
  return isPlatformCredentialId(id) ? id : null;
}

/** The product slot every platform credential is sealed under. No slug can spell it. */
export const PLATFORM_SEAL_PRODUCT = "_platform";

export function platformCredentialContext(
  id: PlatformCredentialId,
): SealContext {
  return { product: PLATFORM_SEAL_PRODUCT, kind: "platform-credential", id };
}

type ValueOf<I extends PlatformCredentialId> =
  OutletCredentialValues[(typeof PLATFORM_CREDENTIALS)[I]["kind"]];

// ── resolve (no open) ────────────────────────────────────────────────────────────────────────

export type PlatformCredentialSource = "console" | "secret";

/** Which source a credential would be opened from, without opening it. */
export interface PlatformCredentialRef {
  id: PlatformCredentialId;
  source: PlatformCredentialSource;
  /** A non-secret version marker: changes whenever the value does. Caches key by it. */
  version: string;
  /** Non-secret display fields (key id, issuer id). */
  meta: OutletCredentialMeta;
}

function parseMeta(json: string): OutletCredentialMeta {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: OutletCredentialMeta = {};
    for (const [k, v] of Object.entries(parsed))
      if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

interface ConsoleRow {
  kind: string;
  enc_value_json: string;
  meta_json: string;
  status: string;
}

async function consoleRow(
  db: Db,
  id: PlatformCredentialId,
): Promise<ConsoleRow | null> {
  const row = await db.first<ConsoleRow>(
    "SELECT kind, enc_value_json, meta_json, status FROM platform_credentials WHERE credential_id = ?",
    id,
  );
  return row &&
    row.status === "active" &&
    row.kind === PLATFORM_CREDENTIALS[id].kind
    ? row
    : null;
}

/** Per-isolate memo of a secret's validation, keyed by its raw text. A secret only changes with
 *  a deploy, which starts new isolates, so this is never stale in practice — and if it were, the
 *  open re-validates anyway. */
const secretMemo = new Map<
  string,
  { ok: true; meta: OutletCredentialMeta; version: string } | { ok: false }
>();

async function secretState(
  env: Env,
  id: PlatformCredentialId,
): Promise<
  | { present: false }
  | { present: true; valid: false }
  | {
      present: true;
      valid: true;
      raw: string;
      meta: OutletCredentialMeta;
      version: string;
    }
> {
  const raw = env[PLATFORM_CREDENTIALS[id].secretName];
  if (typeof raw !== "string" || raw.trim() === "") return { present: false };
  const key = `${id}\n${raw}`;
  let hit = secretMemo.get(key);
  if (!hit) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const checked = await validateOutletCredential(
      PLATFORM_CREDENTIALS[id].kind,
      parsed,
    );
    hit = checked.ok
      ? {
          ok: true,
          meta: checked.meta,
          version: `s${(await sha256Hex(raw)).slice(0, 31)}`,
        }
      : { ok: false };
    if (secretMemo.size >= 32) secretMemo.clear();
    secretMemo.set(key, hit);
  }
  return hit.ok
    ? { present: true, valid: true, raw, meta: hit.meta, version: hit.version }
    : { present: true, valid: false };
}

async function versionOf(encValueJson: string): Promise<string> {
  return `c${(await sha256Hex(encValueJson)).slice(0, 31)}`;
}

/**
 * The credential a platform slot would be opened from — the console row if one is active, else a
 * valid Worker secret — or `null` when neither is usable. Nothing is decrypted and nothing is
 * audited: the answer is metadata. This is the resolver A-17's provisioning reuses.
 */
export async function resolvePlatformCredential(
  env: Env,
  db: Db,
  id: PlatformCredentialId,
): Promise<PlatformCredentialRef | null> {
  const row = await consoleRow(db, id);
  if (row)
    return {
      id,
      source: "console",
      version: await versionOf(row.enc_value_json),
      meta: parseMeta(row.meta_json),
    };
  const s = await secretState(env, id);
  if (s.present && s.valid)
    return { id, source: "secret", version: s.version, meta: s.meta };
  return null;
}

// ── status (the API's view) ──────────────────────────────────────────────────────────────────

export interface PlatformCredentialStatus {
  id: PlatformCredentialId;
  store: PlatformStore;
  slot: string;
  kind: OutletCredentialKind;
  label: string;
  configured: boolean;
  /** The source a connector would use now. */
  source: PlatformCredentialSource | null;
  /** Key id and issuer id of the credential in use. Never the key. */
  meta: OutletCredentialMeta | null;
  console: {
    present: boolean;
    status: string | null;
    meta: OutletCredentialMeta | null;
    createdAt: number | null;
    createdBy: string | null;
    rotatedAt: number | null;
    lastUsedAt: number | null;
    lastOkAt: number | null;
    lastError: string | null;
  };
  secret: { name: string; present: boolean; valid: boolean };
  /** What a product's pin on this credential names, and how many products hold one. */
  pinField: string;
  pins: number;
}

/** Presence and metadata of one platform credential: never a value. */
export async function platformCredentialStatus(
  env: Env,
  db: Db,
  id: PlatformCredentialId,
): Promise<PlatformCredentialStatus> {
  const spec = PLATFORM_CREDENTIALS[id];
  const row = await db.first<{
    status: string;
    meta_json: string;
    created_at: number;
    created_by: string;
    rotated_at: number | null;
    last_used_at: number | null;
    last_ok_at: number | null;
    last_error: string | null;
  }>(
    `SELECT status, meta_json, created_at, created_by, rotated_at, last_used_at, last_ok_at, last_error
       FROM platform_credentials WHERE credential_id = ?`,
    id,
  );
  const s = await secretState(env, id);
  const ref = await resolvePlatformCredential(env, db, id);
  const pins = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM platform_credential_pins WHERE credential_id = ?",
    id,
  );
  return {
    id,
    store: spec.store,
    slot: spec.slot,
    kind: spec.kind,
    label: spec.label,
    configured: ref !== null,
    source: ref?.source ?? null,
    meta: ref?.meta ?? null,
    console: {
      present: row !== null,
      status: row?.status ?? null,
      meta: row ? parseMeta(row.meta_json) : null,
      createdAt: row?.created_at ?? null,
      createdBy: row?.created_by ?? null,
      rotatedAt: row?.rotated_at ?? null,
      lastUsedAt: row?.last_used_at ?? null,
      lastOkAt: row?.last_ok_at ?? null,
      lastError: row?.last_error ?? null,
    },
    secret: {
      name: spec.secretName,
      present: s.present,
      valid: s.present && s.valid,
    },
    pinField: spec.pinField,
    pins: Number(pins?.n ?? 0),
  };
}

// ── write ────────────────────────────────────────────────────────────────────────────────────

export type PutPlatformCredentialResult =
  | { ok: true; created: boolean; meta: OutletCredentialMeta }
  | { ok: false; status: 422; field: string; message: string };

/**
 * Validate (with the kind's own outlet-credential validator — `validateAscApiKey` for the API
 * key), seal and store the console credential of one slot; an existing row is rotated in place
 * and its health columns cleared. Called ONLY from the Core admin handler, which audits it. The
 * result carries the display metadata (key id, issuer id), never the value.
 */
export async function putPlatformCredential(
  env: Env,
  db: Db,
  input: {
    id: PlatformCredentialId;
    value: unknown;
    actor: string;
    now: number;
  },
): Promise<PutPlatformCredentialResult> {
  const spec = PLATFORM_CREDENTIALS[input.id];
  const checked = await validateOutletCredential(spec.kind, input.value);
  if (!checked.ok)
    return {
      ok: false,
      status: 422,
      field: checked.field,
      message: checked.message,
    };
  const enc = await seal(
    env,
    JSON.stringify(checked.value),
    platformCredentialContext(input.id),
  );
  const existing = await db.first<{ n: number }>(
    "SELECT 1 AS n FROM platform_credentials WHERE credential_id = ?",
    input.id,
  );
  if (existing) {
    await db.run(
      `UPDATE platform_credentials
          SET kind = ?, enc_value_json = ?, meta_json = ?, status = 'active', rotated_at = ?,
              last_used_at = NULL, last_ok_at = NULL, last_error = NULL
        WHERE credential_id = ?`,
      spec.kind,
      enc,
      JSON.stringify(checked.meta),
      input.now,
      input.id,
    );
  } else {
    await db.run(
      `INSERT INTO platform_credentials
         (credential_id, store, slot, kind, enc_value_json, meta_json, status, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      input.id,
      spec.store,
      spec.slot,
      spec.kind,
      enc,
      JSON.stringify(checked.meta),
      input.now,
      input.actor,
    );
  }
  return { ok: true, created: !existing, meta: checked.meta };
}

/** Delete the console credential of one slot (the Worker secret, if set, takes over). `true`
 *  when a row was removed. Pins are kept: they are the operator's assignments, not the key's. */
export async function deletePlatformCredential(
  db: Db,
  id: PlatformCredentialId,
): Promise<boolean> {
  return (
    (await db.runChanges(
      "DELETE FROM platform_credentials WHERE credential_id = ?",
      id,
    )) > 0
  );
}

// ── pins ─────────────────────────────────────────────────────────────────────────────────────

export interface PlatformPin {
  product: string;
  pin: string;
  pinnedAt: number;
  pinnedBy: string;
}

/** The product's pin on a platform credential, or `null`: no pin, no use. */
export async function platformPin(
  db: Db,
  id: PlatformCredentialId,
  product: string,
): Promise<string | null> {
  const row = await db.first<{ pin: string }>(
    "SELECT pin FROM platform_credential_pins WHERE credential_id = ? AND product = ?",
    id,
    product,
  );
  return row?.pin ?? null;
}

/** The product holding `pin` on a platform credential, or `null`. */
export async function platformPinHolder(
  db: Db,
  id: PlatformCredentialId,
  pin: string,
): Promise<string | null> {
  const row = await db.first<{ product: string }>(
    "SELECT product FROM platform_credential_pins WHERE credential_id = ? AND pin = ?",
    id,
    pin,
  );
  return row?.product ?? null;
}

/** Every product's pin on a platform credential, in product order. */
export async function listPlatformPins(
  db: Db,
  id: PlatformCredentialId,
): Promise<PlatformPin[]> {
  const rows = await db.all<{
    product: string;
    pin: string;
    pinned_at: number;
    pinned_by: string;
  }>(
    "SELECT product, pin, pinned_at, pinned_by FROM platform_credential_pins WHERE credential_id = ? ORDER BY product",
    id,
  );
  return rows.map((r) => ({
    product: r.product,
    pin: r.pin,
    pinnedAt: r.pinned_at,
    pinnedBy: r.pinned_by,
  }));
}

export type SetPlatformPinResult =
  | { ok: true; before: string | null; changed: boolean }
  | { ok: false; status: 409; message: string; holder: string }
  | { ok: false; status: 422; message: string };

/**
 * Set a product's pin on a platform credential. 422 for a malformed pin (the kind's own pin
 * pattern), 409 when another product holds it — a check here AND the table's `UNIQUE
 * (credential_id, pin)`, so a race cannot slip two products onto one app. Called ONLY from the
 * Core admin handler, which audits a change.
 */
export async function setPlatformPin(
  db: Db,
  input: {
    id: PlatformCredentialId;
    product: string;
    pin: unknown;
    actor: string;
    now: number;
  },
): Promise<SetPlatformPinResult> {
  const p = validateOutletCredentialPin(
    PLATFORM_CREDENTIALS[input.id].kind,
    input.pin,
  );
  if (!p.ok) return { ok: false, status: 422, message: p.message };
  const holder = await platformPinHolder(db, input.id, p.value);
  if (holder !== null && holder !== input.product)
    return {
      ok: false,
      status: 409,
      holder,
      message: `${PLATFORM_CREDENTIALS[input.id].pinField} ${p.value} is assigned to product ${holder}`,
    };
  const before = await platformPin(db, input.id, input.product);
  if (before === p.value) return { ok: true, before, changed: false };
  try {
    await db.run(
      `INSERT INTO platform_credential_pins (credential_id, product, pin, pinned_at, pinned_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (product, credential_id)
       DO UPDATE SET pin = excluded.pin, pinned_at = excluded.pinned_at, pinned_by = excluded.pinned_by`,
      input.id,
      input.product,
      p.value,
      input.now,
      input.actor,
    );
  } catch (e) {
    if (/UNIQUE/i.test(e instanceof Error ? e.message : ""))
      return {
        ok: false,
        status: 409,
        holder: (await platformPinHolder(db, input.id, p.value)) ?? "",
        message: `${PLATFORM_CREDENTIALS[input.id].pinField} ${p.value} is assigned to another product`,
      };
    throw e;
  }
  return { ok: true, before, changed: true };
}

/**
 * The writes that set (`pin` a string) or release (`pin: null`) products' pins, as statements for
 * ONE atomic batch with the audit rows that record them (A-16's assignment). The caller has
 * already validated each pin and checked holders; the table's `UNIQUE (credential_id, pin)` still
 * fails the whole batch if a racing assignment took an app in between. Named only by this module
 * and the Core admin handler (the reach test's writer allowlist).
 */
export function platformPinWrites(
  ops: Array<{
    id: PlatformCredentialId;
    product: string;
    pin: string | null;
    actor: string;
    now: number;
  }>,
): DbStatement[] {
  return ops.map((o) =>
    o.pin === null
      ? {
          sql: "DELETE FROM platform_credential_pins WHERE credential_id = ? AND product = ?",
          params: [o.id, o.product],
        }
      : {
          sql: `INSERT INTO platform_credential_pins (credential_id, product, pin, pinned_at, pinned_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (product, credential_id)
       DO UPDATE SET pin = excluded.pin, pinned_at = excluded.pinned_at, pinned_by = excluded.pinned_by`,
          params: [o.id, o.product, o.pin, o.now, o.actor],
        },
  );
}

/** Remove a product's pin on a platform credential; answers the pin removed, or `null`. Called
 *  ONLY from the Core admin handler, which audits it. */
export async function clearPlatformPin(
  db: Db,
  id: PlatformCredentialId,
  product: string,
): Promise<string | null> {
  const before = await platformPin(db, id, product);
  if (before === null) return null;
  await db.run(
    "DELETE FROM platform_credential_pins WHERE credential_id = ? AND product = ?",
    id,
    product,
  );
  return before;
}

// ── open ─────────────────────────────────────────────────────────────────────────────────────

export interface OpenedPlatformCredential<
  I extends PlatformCredentialId = PlatformCredentialId,
> {
  id: I;
  source: PlatformCredentialSource;
  value: ValueOf<I>;
  version: string;
}

/**
 * Why a credential is being opened:
 *
 *   - `{ product, pin }` — a product's connector, about to act on the app `pin` names. Opens only
 *     when the product's own pin on this credential equals `pin`; audited in the product's trail.
 *   - `{ team: actor }` — a team-wide read with no product (the platform apps listing, A-17's
 *     provisioning), on behalf of `actor`; audited in the platform trail.
 */
export type PlatformOpenPurpose =
  | { product: string; pin: string }
  | { team: PlatformEventActor };

const USE_RE = /^[a-z0-9][a-z0-9:._-]{0,63}$/;

/**
 * Open one platform credential for one `use` (e.g. `asc:poll`). `null` — "unusable" — when no
 * source is usable, the product's pin does not match, the value will not open or will not
 * re-validate, or `use` is invalid; never throws for any of those, never says which. Every call
 * appends one audit row (see `PlatformOpenPurpose`) and stamps `last_used_at` on a console row.
 * Named only here, in `core/outletTokens.ts`, `connectors/msstore/token.ts` and `commerce/steam.ts`
 * (the reach test's opener allowlist); the token helpers check the pin and their memo or sealed
 * cache first, so a cache hit opens (and audits) nothing.
 */
export async function openPlatformCredential<I extends PlatformCredentialId>(
  env: Env,
  db: Db,
  id: I,
  use: string,
  purpose: PlatformOpenPurpose,
  now: number,
): Promise<OpenedPlatformCredential<I> | null> {
  const spec = PLATFORM_CREDENTIALS[id];
  const validUse = USE_RE.test(use);
  let refused: string | null = validUse ? null : "invalid use";
  if (!refused && "product" in purpose) {
    const pin = await platformPin(db, id, purpose.product);
    if (pin === null) refused = "not pinned";
    else if (pin !== purpose.pin) refused = "pin mismatch";
  }

  let opened: OpenedPlatformCredential<I> | null = null;
  let source: PlatformCredentialSource | null = null;
  if (!refused) {
    const row = await consoleRow(db, id);
    let plaintext: string | null = null;
    let version: string | null = null;
    try {
      if (row) {
        source = "console";
        plaintext = await open(
          env,
          row.enc_value_json,
          platformCredentialContext(id),
        );
        version = await versionOf(row.enc_value_json);
      } else {
        const s = await secretState(env, id);
        if (s.present && s.valid) {
          source = "secret";
          plaintext = s.raw;
          version = s.version;
        }
      }
      if (plaintext !== null && version !== null && source !== null) {
        const checked = await validateOutletCredential(
          spec.kind,
          JSON.parse(plaintext) as unknown,
        );
        if (checked.ok)
          opened = {
            id,
            source,
            value: checked.value as ValueOf<I>,
            version,
          };
      }
    } catch {
      opened = null;
    }
  }

  const summary = `${validUse ? use : "(invalid use)"}: ${
    opened
      ? `opened (${opened.source})`
      : `unusable credential${refused ? ` (${refused})` : ""}`
  }`;
  if ("product" in purpose) {
    await appendAudit(db, {
      product: purpose.product,
      id: randomId("aud"),
      at: now,
      actor_sub: OUTLET_CREDENTIAL_ACTOR,
      actor_name: "Distribution service",
      actor_email: null,
      action: "platform_credential.use",
      target_kind: "platform_credential",
      target_id: id,
      parent_id: null,
      summary,
    });
  } else {
    await appendPlatformEvent(db, {
      actor: purpose.team,
      at: now,
      action: "platform_credential.use",
      target: { kind: "platform_credential", id },
      summary: `${summary} (team-wide, via ${PLATFORM_SYSTEM_ACTOR.sub})`,
    });
  }
  if (source === "console")
    await db.run(
      "UPDATE platform_credentials SET last_used_at = ? WHERE credential_id = ?",
      now,
      id,
    );
  return opened;
}

const MAX_ERROR = 200;

/** Record what the store said when a console credential was used (`last_ok_at` / `last_error`).
 *  A no-op for the Worker-secret source, which has no row. The caller passes a status line it
 *  composed — never a response body or anything derived from the credential. */
export async function recordPlatformCredentialResult(
  db: Db,
  id: PlatformCredentialId,
  result: { ok: true } | { ok: false; error: string },
  now: number,
): Promise<void> {
  if (result.ok)
    await db.run(
      "UPDATE platform_credentials SET last_ok_at = ?, last_error = NULL WHERE credential_id = ?",
      now,
      id,
    );
  else
    await db.run(
      "UPDATE platform_credentials SET last_error = ? WHERE credential_id = ?",
      result.error.slice(0, MAX_ERROR),
      id,
    );
}
