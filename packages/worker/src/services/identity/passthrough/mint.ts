/// <reference types="@cloudflare/workers-types" />

/**
 * The first automatic licence, and the claim that makes it once (plans/I-27.md §2.2, plans/I-08.md
 * D5, brief I-08b).
 *
 * The press that creates a licence for an account is Continue (card mode) or `choice/complete`
 * with `create` (app mode); the device binds after, at `token` or in the same request. Until LX-38
 * puts a unique index on `licenses(product, account_id)`, the only guard against two licences is a
 * claim in I-02's atomic store:
 *
 *   address   `license-mint`, `<product>:` and a peppered hash of the account id.
 *   write     `putArtefact(…, 30, {ifAbsent: true})`: of any number of concurrent presses, one wins.
 *   winner    re-reads the offer and mints only if it is still right to (`first`: still no
 *             candidate; `create`: still no free candidate), then deletes the claim.
 *   loser     mints nothing and answers `lost`; the caller answers 409 `license_choice_required`,
 *             and the card re-reads `licenses`, which now lists the winner's licence.
 *   store     an unreachable store throws, so the press fails closed and nothing is minted.
 *
 * Discover's `issueIdentityLicense` takes the same claim (`withMintClaim`), so a Discover add that
 * races a Continue also mints once.
 */

import type { Env } from "../../../platform/env.js";
import type { ProductPublic } from "../../../core/products.js";
import type { LicenseRow } from "../../../core/repo.js";
import { hashKey } from "../../../platform/crypto.js";
import {
  artefactRef,
  deleteArtefact,
  putArtefact,
} from "../../../core/singleUse.js";
import { getLicense } from "../../../core/licensing/store.js";
import { issueAccountLicense } from "../../../core/licensing/issueAccount.js";
import { offerFor, grantFor, type ChoiceCx } from "./choice.js";

/** The claim outlives any mint (a few statements); it is deleted on the way out. */
const CLAIM_TTL_SECONDS = 30;

async function claimRef(env: Env, product: string, accountId: string) {
  return artefactRef(
    "license-mint",
    `${product}:${await hashKey(accountId, env.KEY_HASH_PEPPER)}`,
  );
}

/**
 * Run `fn` holding the account's mint claim, or answer `lost` without running it. Throws when the
 * store is unreachable (fail closed). The claim is released afterwards; if the delete fails the
 * 30 s expiry does it.
 */
export async function withMintClaim<T>(
  env: Env,
  product: Pick<ProductPublic, "slug">,
  accountId: string,
  fn: () => Promise<T>,
): Promise<{ won: true; value: T } | { won: false }> {
  const ref = await claimRef(env, product.slug, accountId);
  if (
    !(await putArtefact(env, ref, "1", CLAIM_TTL_SECONDS, { ifAbsent: true }))
  )
    return { won: false };
  try {
    return { won: true, value: await fn() };
  } finally {
    try {
      await deleteArtefact(env, ref);
    } catch {
      /* the 30 s expiry releases it */
    }
  }
}

export type MintOutcome =
  | { kind: "minted"; license: LicenseRow }
  /** Another press holds the claim. */
  | { kind: "lost" }
  /** The account holds a licence the person has not chosen (first), or a free one (create). */
  | { kind: "candidate" }
  /** The product's policy grants this account nothing. */
  | { kind: "not_granted" };

/**
 * Mint the account's licence for `product`.
 *   first   the account has no candidate (the card showed the "New" row and skipped the choice);
 *   create  every candidate is full and the person asked for "Create a new license".
 * `device` is the installation about to bind, when there is one (it can make a candidate "current").
 */
export async function mintAccountLicense(
  cx: ChoiceCx,
  accountId: string,
  mode: "first" | "create",
  device: string | null,
): Promise<MintOutcome> {
  const grant = await grantFor(cx, accountId);
  if (!grant) return { kind: "not_granted" };
  const claim = await withMintClaim(cx.env, cx.product, accountId, async () => {
    // Re-read inside the claim: a press that won before us may have finished.
    const offer = await offerFor(cx, accountId, device);
    if (mode === "first" ? offer.candidates.length > 0 : !offer.create)
      return { kind: "candidate" as const };
    const issued = await issueAccountLicense(
      cx.db,
      cx.product,
      accountId,
      grant.identity,
      { kind: "oidc", env: cx.env },
      cx.now,
    );
    if ("error" in issued) return { kind: "not_granted" as const };
    const license = await getLicense(cx.db, cx.product.slug, issued.licenseId);
    return license
      ? { kind: "minted" as const, license }
      : { kind: "not_granted" as const };
  });
  return claim.won ? claim.value : { kind: "lost" };
}
