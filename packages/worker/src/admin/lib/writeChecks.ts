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

import { representabilityIssue } from "@polaris-key/catalog";
import { CHANNEL_RE, ID_RE, KID_RE, SEMVER_RE } from "@polaris-key/manifest";
import { MAX_WIRE_INTEGER } from "@polaris-key/protocol/core";
import { ErrorCode } from "../../core/errors.js";
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

/** A whole catalog (manual create, catalog publish): `null`, or the `422` naming the entry. */
export function catalogRepresentabilityResponse(
  catalog: unknown,
): Response | null {
  const issue = representabilityIssue(catalog);
  if (!issue) return null;
  return err(
    422,
    ErrorCode.ValueNotRepresentable,
    `a catalog value cannot be carried by a signed document (${issue.rule})`,
    { fields: [`catalog${issue.path}`] },
  );
}
