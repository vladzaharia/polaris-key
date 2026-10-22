/**
 * The provisioned-secret backfill planner (U-27.5; plans/U-27-P2-12-slices.md §A2, L-U2..L-U4).
 *
 * U-27.2 makes an owned licence's sign-in write its provisioned secrets onto the owner's account
 * row. Licences provisioned before that hold the same secrets in `licenses.overrides_json`. This
 * module decides, purely, which of those copies may move up one layer (licence column -> owner's
 * account row) with every device's merged document value-equal: every key and value is the same;
 * the order of keys inside the document's `secrets` may change once, because `mergeMap` orders keys
 * by layer insertion and a moved key re-enters at the account layer's position. It does no I/O, no
 * sealing and no decrypting: the caller (the U-27.6 job) reads the rows, passes them in, and
 * applies the plan. Sealed values are compared as stored (one canonical JSON of the whole
 * `ManagedEntry`); every managed secret shares one AAD (`pkey:v2:<product>:managed-secret:<key>`,
 * U-27.2), so a moved entry is valid where it lands and nothing is re-sealed.
 *
 * WHY A MOVE CHANGES NO VALUE. Licence overrides (layer 4) sit directly below the account layer
 * (layer 5). A secret in the account layer reaches exactly the devices whose override subject is
 * the owner AND that are signed in as that subject: `accountOverrideLayer` strips the owner's
 * secrets for a device that only reached the owner through the owner line (a licence-key device).
 * So a copy may leave the column only when every active device of the licence is signed in as the
 * owner. Adding the entry to the row also reaches every device signed in as the owner on ANY
 * licence, so the planner requires each of those to hold that very entry in its own column.
 * Removing a copy under an account entry that already holds the key changes nothing only when
 * the account entry fully wins `mergePayloads` (see `shadowIsInvisible`).
 *
 * Output classes, per (licence, key):
 *  - `moves`: owned, every active device signed in as the owner, and the entry is the one
 *    the account row will hold; remove from the column, and `addToAccount` says whether this
 *    move also puts the entry on the row (exactly one move per (owner, key) does, the
 *    lowest licence id).
 *  - `shadowed`: the owner's row already holds the key. The account value wins for the owner's
 *    signed-in devices, so the column copy is invisible; remove it from the column only.
 *  - `conflicts`: several owned licences of one owner hold different entries and the row lacks
 *    the key (L-U4); or the row holds the key but the column copy still shows through the merge
 *    (`reason: "shadowVisible"`). The holders are skipped.
 *  - `otherSubject`: a licence with a device that is not signed in as the owner (L-U2, strict;
 *    expected 0), or a move whose row entry would reach a device signed in as the owner that does
 *    not hold the same entry (`reason`: `otherSubject`, `licenceKeyDevice`, `exposure`).
 *  - `unowned`: how many licences with a declared key have no owner (the column stays).
 */

import type { ManagedEntry } from "@polaris-key/protocol";
import { parseAccountOverridePayload } from "../accounts/accountOverrides.js";

/** A licence as the planner reads it. `ownerSubject` is the owner's canonical subject for the
 *  product, or `null` for a floating licence, one waiting on its email, or an owner with no
 *  subject (all unowned here). */
export interface PlanLicence {
  id: string;
  ownerSubject: string | null;
  overridesJson: string | null;
}

/** One ACTIVE device, resolved by the caller through `overrideSubject` and grouped under its
 *  override subject in `devicesBySubject` (key `null` = no subject). `signedIn` is true when the
 *  first line (the device's own signed-in subject) answered, false when only the owner line did. */
export interface PlanDevice {
  licenseId: string;
  signedIn: boolean;
}

export interface PlanInput {
  product: string;
  /** The product's declared provisioned secret keys (`provisioningDeclaredKeys().secrets`). */
  declared: ReadonlySet<string>;
  licences: readonly PlanLicence[];
  /** `account_overrides.payload_json` by canonical subject; absent or `null` = no row. */
  accountRows: ReadonlyMap<string, string | null>;
  /** Every active device of the product, by its resolved override subject (`null` = none). */
  devicesBySubject: ReadonlyMap<string | null, readonly PlanDevice[]>;
}

export interface SecretMove {
  licenseId: string;
  key: string;
  subject: string;
  /** The entry exactly as stored (sealed): what the job adds to the row. Never log it. */
  entry: ManagedEntry;
  addToAccount: boolean;
}

export interface SecretShadow {
  licenseId: string;
  key: string;
  subject: string;
}

export interface SecretConflict {
  subject: string;
  key: string;
  reason: "differentValues" | "shadowVisible";
  licenseIds: string[];
}

export interface SecretSkip {
  licenseId: string;
  key: string;
  reason: "otherSubject" | "licenceKeyDevice" | "exposure";
}

export interface SecretMalformed {
  licenseId: string;
  key: string;
}

export interface ProvisionedSecretPlan {
  moves: SecretMove[];
  shadowed: SecretShadow[];
  conflicts: SecretConflict[];
  otherSubject: SecretSkip[];
  unowned: number;
  /** Declared-key entries that are not a `ManagedEntry`; left in place. */
  malformed: SecretMalformed[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** One canonical JSON (sorted keys) so equal entries compare equal whatever their key order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isRecord(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

function isEntry(v: unknown): v is ManagedEntry {
  return (
    isRecord(v) &&
    typeof v.state === "string" &&
    "value" in v &&
    typeof v.updatedAt === "number"
  );
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Holder {
  licenseId: string;
  key: string;
  subject: string;
  entry: ManagedEntry;
  text: string;
  /** null = the licence's own devices allow the column copy to leave. */
  skip: SecretSkip["reason"] | null;
}

/**
 * Whether dropping a column copy under an account entry that already holds the key leaves every
 * merged document as it was. `mergePayloads` keeps a lower `enforced`/`hidden` entry against an
 * account `default` one, and stamps `updatedAt` with the later of both layers; so the copy is
 * invisible only when it is not newer than the account entry and either the account entry is
 * itself `enforced`/`hidden` or the copy is `default`. Whatever lower layers (tier, profile,
 * catalog default) hold, `merge(base, copy, account) == merge(base, account)` then.
 */
function shadowIsInvisible(copy: ManagedEntry, account: unknown): boolean {
  if (!isEntry(account)) return false;
  if (copy.updatedAt > account.updatedAt) return false;

  return account.state !== "default" || copy.state === "default";
}

export function planProvisionedSecretMoves(
  input: PlanInput,
): ProvisionedSecretPlan {
  const plan: ProvisionedSecretPlan = {
    moves: [],
    shadowed: [],
    conflicts: [],
    otherSubject: [],
    unowned: 0,
    malformed: [],
  };
  const keys = [...input.declared].sort(byText);
  const holders: Holder[] = [];
  /** licence id -> key -> canonical entry, for every licence (owned or not). */
  const columnText = new Map<string, Map<string, string>>();

  const devicesOf = new Map<
    string,
    { subject: string | null; signedIn: boolean }[]
  >();
  for (const [subject, devices] of input.devicesBySubject)
    for (const d of devices) {
      const list = devicesOf.get(d.licenseId) ?? [];
      list.push({ subject, signedIn: d.signedIn });
      devicesOf.set(d.licenseId, list);
    }

  for (const licence of [...input.licences].sort((a, b) =>
    byText(a.id, b.id),
  )) {
    let secrets: Record<string, unknown> = {};
    if (licence.overridesJson) {
      try {
        const p: unknown = JSON.parse(licence.overridesJson);
        if (isRecord(p) && isRecord(p.secrets)) secrets = p.secrets;
      } catch {
        // an unreadable column holds nothing to move
      }
    }
    const held = keys.filter((k) => Object.hasOwn(secrets, k));
    if (held.length === 0) continue;
    const texts = new Map<string, string>();
    columnText.set(licence.id, texts);
    for (const k of held)
      if (isEntry(secrets[k])) texts.set(k, canonicalJson(secrets[k]));
    const owner = licence.ownerSubject;
    if (owner === null) {
      plan.unowned++;
      continue;
    }
    const devices = devicesOf.get(licence.id) ?? [];
    let skip: Holder["skip"] = null;
    if (devices.some((d) => d.subject !== owner)) skip = "otherSubject";
    else if (devices.some((d) => !d.signedIn)) skip = "licenceKeyDevice";
    for (const key of held) {
      const entry = secrets[key];
      if (!isEntry(entry)) {
        plan.malformed.push({ licenseId: licence.id, key });
        continue;
      }
      holders.push({
        licenseId: licence.id,
        key,
        subject: owner,
        entry,
        text: canonicalJson(entry),
        skip,
      });
    }
  }

  // Group by (owner subject, key).
  const groups = new Map<string, Holder[]>();
  for (const h of holders) {
    const id = canonicalJson([h.subject, h.key]);
    const g = groups.get(id);
    if (g) g.push(h);
    else groups.set(id, [h]);
  }

  const skipAll = (group: Holder[], reason: SecretSkip["reason"]): void => {
    for (const h of group)
      plan.otherSubject.push({
        licenseId: h.licenseId,
        key: h.key,
        reason: h.skip ?? reason,
      });
  };

  for (const group of groups.values()) {
    const first = group[0] as Holder;
    const { subject, key } = first;
    const accountEntry = parseAccountOverridePayload(
      input.accountRows.get(subject) ?? null,
    ).secrets[key];
    const rowHasKey = accountEntry !== undefined;

    if (rowHasKey) {
      // Only the licence's own devices see the column copy go.
      const visible = group.filter(
        (h) => h.skip === null && !shadowIsInvisible(h.entry, accountEntry),
      );
      if (visible.length > 0)
        plan.conflicts.push({
          subject,
          key,
          reason: "shadowVisible",
          licenseIds: visible.map((h) => h.licenseId),
        });
      for (const h of group) {
        if (h.skip !== null)
          plan.otherSubject.push({
            licenseId: h.licenseId,
            key,
            reason: h.skip,
          });
        else if (!visible.includes(h))
          plan.shadowed.push({ licenseId: h.licenseId, key, subject });
      }
      continue;
    }

    if (new Set(group.map((h) => h.text)).size > 1) {
      plan.conflicts.push({
        subject,
        key,
        reason: "differentValues",
        licenseIds: group.map((h) => h.licenseId),
      });
      continue;
    }

    // Adding the entry to the row reaches every device signed in as the owner, on any licence:
    // each must already receive exactly this entry from its own licence column.
    const text = first.text;
    const exposed = (input.devicesBySubject.get(subject) ?? []).some(
      (d) => d.signedIn && columnText.get(d.licenseId)?.get(key) !== text,
    );
    if (exposed) {
      skipAll(group, "exposure");
      continue;
    }
    let added = false;
    for (const h of group) {
      if (h.skip !== null) {
        plan.otherSubject.push({ licenseId: h.licenseId, key, reason: h.skip });
        continue;
      }
      plan.moves.push({
        licenseId: h.licenseId,
        key,
        subject,
        entry: h.entry,
        addToAccount: !added,
      });
      added = true;
    }
  }

  const order = (a: { licenseId: string; key: string }, b: typeof a): number =>
    byText(a.licenseId, b.licenseId) || byText(a.key, b.key);
  plan.moves.sort(order);
  plan.shadowed.sort(order);
  plan.otherSubject.sort(order);
  plan.malformed.sort(order);
  plan.conflicts.sort(
    (a, b) => byText(a.subject, b.subject) || byText(a.key, b.key),
  );
  return plan;
}

/** The plan as a report may carry it: counts and capped ids, never an entry or a value. */
export function summarizePlan(
  plan: ProvisionedSecretPlan,
  cap = 20,
): Record<string, unknown> {
  const ids = (xs: { licenseId: string }[]): string[] =>
    [...new Set(xs.map((x) => x.licenseId))].slice(0, cap);
  return {
    moves: plan.moves.length,
    addToAccount: plan.moves.filter((m) => m.addToAccount).length,
    shadowed: plan.shadowed.length,
    conflicts: plan.conflicts.length,
    otherSubject: plan.otherSubject.length,
    unowned: plan.unowned,
    malformed: plan.malformed.length,
    moveLicenceIds: ids(plan.moves),
    conflictLicenceIds: [
      ...new Set(plan.conflicts.flatMap((c) => c.licenseIds)),
    ].slice(0, cap),
    otherSubjectLicenceIds: ids(plan.otherSubject),
  };
}
