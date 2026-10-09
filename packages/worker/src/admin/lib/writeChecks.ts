/**
 * Write checks for the values the admin product, tier and licence handlers store and the
 * Worker later signs (plans/P3-01.md §2.2, "Every value a v3 document carries").
 *
 * Several handlers used to store a value with less checking than the manifest validator applies
 * to the same value, so a console or API write could put something in D1 that the manifest
 * would refuse — and, once the signer guards landed, something no document could carry. These
 * checks take the manifest's own rule for each value (`@polaris-key/manifest` exports the
 * patterns it already applies), so no rule is new:
 *
 *   - a pattern or a range (`ID_RE`, `CHANNEL_RE`, `SEMVER_RE`, `KID_RE`, `MAX_WIRE_INTEGER`,
 *     an integer day count from 1 to 365) answers the handlers' existing `422 bad_request`
 *     with `fields`;
 *   - free text (a licence name or email, a tier label) that `representabilityIssue` flags
 *     answers `422 value_not_representable` with `fields`.
 *
 * A value a handler does not touch is not checked, so a write that leaves an old value alone
 * still succeeds; plan §8 risk 11 records that a stored value which only fails a pattern still
 * signs, and is refused the next time a write touches it.
 */

import { catalogKeyIssue, representabilityIssue } from "@polaris-key/catalog";
import {
  CHANNEL_RE,
  ID_RE,
  KID_RE,
  reservedNameMessage,
  SEMVER_RE,
  type ReservedNamesMode,
} from "@polaris-key/manifest";
import { MAX_WIRE_INTEGER } from "@polaris-key/protocol/core";
import { ErrorCode } from "../../core/errors.js";
import { incompatibleReservedNames } from "../../core/reservedNames.js";
import { err } from "./respond.js";

/** The offline-day range the bundle mint already enforces (`core/bundles.ts`). */
export const MIN_OFFLINE_DAYS = 1;
export const MAX_OFFLINE_DAYS = 365;

/** True when `value` is absent: not in the body, or an explicit `null` (the handlers' "clear"). */
function absent(value: unknown): boolean {
  return value === undefined || value === null;
}

/** Collects the failing fields of one request, then answers with the right `422`. */
export class WriteChecks {
  private readonly bad: string[] = [];
  private readonly unrepresentable: string[] = [];

  /** A present value must be a string matching `re` in full. */
  pattern(field: string, value: unknown, re: RegExp): this {
    if (!absent(value) && (typeof value !== "string" || !re.test(value)))
      this.bad.push(field);
    return this;
  }

  /** `ID_RE` ids (tiers), `KID_RE` kids, `SEMVER_RE` version bounds. */
  id(field: string, value: unknown): this {
    return this.pattern(field, value, ID_RE);
  }

  kid(field: string, value: unknown): this {
    return this.pattern(field, value, KID_RE);
  }

  semver(field: string, value: unknown): this {
    return this.pattern(field, value, SEMVER_RE);
  }

  /** A present `channels` array: every entry a string matching `CHANNEL_RE`. Anything that is
   *  not an array keeps its existing meaning in the handler (it clears the column). */
  channels(field: string, value: unknown): this {
    if (!Array.isArray(value)) return this;
    value.forEach((name, i) => {
      if (typeof name !== "string" || !CHANNEL_RE.test(name))
        this.bad.push(`${field}.${i}`);
    });
    return this;
  }

  /** A present offline-day count: an integer from 1 to 365, the bundle mint's rule. */
  offlineDays(field: string, value: unknown): this {
    if (
      !absent(value) &&
      !(
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= MIN_OFFLINE_DAYS &&
        value <= MAX_OFFLINE_DAYS
      )
    )
      this.bad.push(field);
    return this;
  }

  /** A present number must be at most `MAX_WIRE_INTEGER` (the handler checks the rest). */
  wireInteger(field: string, value: unknown): this {
    if (typeof value === "number" && !(value <= MAX_WIRE_INTEGER))
      this.bad.push(field);
    return this;
  }

  /** An absent or `null` expiry is fine; a present one must be a whole, in-range number of
   *  seconds: a fraction or string would 500 the document or read as perpetual. */
  expiresAt(field: string, value: unknown): this {
    if (value === undefined || value === null) return this;
    if (
      !(
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= MAX_WIRE_INTEGER
      )
    )
      this.bad.push(field);
    return this;
  }

  /** Free text a signed document carries: refused when `representabilityIssue` flags it. */
  text(field: string, value: unknown): this {
    if (typeof value === "string" && representabilityIssue(value) !== null)
      this.unrepresentable.push(field);
    return this;
  }

  /** `null` when every check passed; otherwise the `422` to answer. */
  response(): Response | null {
    if (this.unrepresentable.length > 0)
      return err(
        422,
        ErrorCode.ValueNotRepresentable,
        "a value cannot be carried by a signed document (a lone surrogate)",
        { fields: [...this.unrepresentable, ...this.bad] },
      );
    if (this.bad.length > 0)
      return err(422, ErrorCode.BadRequest, "validation failed", {
        fields: this.bad,
      });
    return null;
  }
}

/**
 * A whole catalog (manual create, catalog publish): `null`, or the `422` naming the entry.
 *
 * Two halves, because an entry key is a string VALUE inside the catalog but a MEMBER NAME in
 * every document that carries it (`config.<key>`, `secrets.<key>`, `entitlements.<key>`):
 *
 *   - `catalogKeyIssue` applies the member-name rules to the keys (a lone surrogate, U+0000,
 *     two keys of one kind equal after NFC) and `representabilityIssue` walks the rest (a
 *     default) — either answers `422 value_not_representable`;
 *   - every key must then match the manifest validator's own `ID_RE` (`entries[i].key`), so a
 *     console write cannot store a key a `.pkey/schema` could not declare — `422 bad_request`.
 *
 * `new Catalog(...)` applies no key rule of its own, so without this a console write could
 * store a key the signer guard refuses (U+0000) or one Swift reads differently from every
 * other verifier (an NFC pair), and no prune would catch it: the prune checks values.
 */
export function catalogRepresentabilityResponse(
  catalog: unknown,
): Response | null {
  const issue = catalogKeyIssue(catalog) ?? representabilityIssue(catalog);
  if (issue)
    return err(
      422,
      ErrorCode.ValueNotRepresentable,
      `a catalog value cannot be carried by a signed document (${issue.rule})`,
      { fields: [`catalog${issue.path}`] },
    );
  const entries = (catalog as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return null;
  const bad: string[] = [];
  entries.forEach((entry: unknown, i) => {
    const key = (entry as { key?: unknown } | null)?.key;
    if (typeof key !== "string" || !ID_RE.test(key))
      bad.push(`catalog/entries/${i}/key`);
  });
  return bad.length > 0
    ? err(422, ErrorCode.BadRequest, "validation failed", { fields: bad })
    : null;
}

/**
 * A whole catalog (manual create, catalog publish) under the platform's reserved-name severity
 * (S-19 §7.4, LX-05): `null` in `warn` mode or when every reserved-name declaration is compatible;
 * in `error` mode the `422` naming each incompatible entry. In `warn` mode the declaration is
 * accepted here and listed on Platform → Settings → Licensing.
 */
export function reservedNamesResponse(
  catalog: unknown,
  mode: ReservedNamesMode,
): Response | null {
  if (mode !== "error") return null;
  const bad = incompatibleReservedNames(catalog);
  if (bad.length === 0) return null;
  return err(422, ErrorCode.BadRequest, reservedNameMessage(bad[0]!, mode), {
    reason: "incompatible_reserved_name",
    fields: bad.map((d) => `catalog/entries/${d.index}/key`),
  });
}
