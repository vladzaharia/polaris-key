---
title: "Troubleshoot managed config"
description: "Find the cause of a config error from the code or message you see."
type: "troubleshooting"
lastReviewed: "2026-10-16"
sidebar:
  order: 8
---

Entries are ordered by how often they happen. Every code is in the [error codes](/docs/reference/error-codes/) reference.

## A value isn't what I set

**Cause** A layer further along the merge won, or the state kept a lower value. Layers run catalog default, tier profile, license profiles, license overrides, account overrides, device overrides. A later Default can't demote an Enforced or Hidden value. On the client, an Enforced value beats a local override and the environment.

**Fix** Check the key's state on each layer. See [Management states](/docs/features/managed-config/management-states/). A `config` key with no schema `default` and no layer value is absent from the document, and the client's fallback answers.

**Check it works** The client reports the expected value after its next sync.

## 422 on publish or save

**Cause** A value or schema failed validation. A catalog fragment may use an unsupported keyword, a pattern the engine refuses, or exceed a budget. A profile `PUT` is all-or-nothing, so one bad key fails the batch.

**Fix** Read `fields` in the response: it names every failing key and reason. For a catalog, see [The catalog](/docs/features/managed-config/catalog/).

**Check it works** The publish succeeds and the version number increases.

## catalog_version_conflict

**Cause** Someone published while your draft was open. `currentVersion` says what is active.

**Fix** Review your draft against the newer version in the editor, or discard it.

**Check it works** The publish succeeds.

## catalog_unavailable

**Cause** The product's active catalog couldn't validate the payload, so no document was signed. The product has no active catalog, or it failed to load.

**Fix** Publish a catalog under **Config → Catalog**, then fetch again.

**Check it works** The config document request returns `200`.

## unauthorized

**Cause** The config document needs a device token, and a license the device is bound to must still be usable.

**Fix** Activate or register the device again, or re-enable the license. See [Troubleshoot licensing](/docs/features/licensing/troubleshooting/).

**Check it works** The document request returns `200`.

## Edge mint answers 404

**Cause** The recipe doesn't exist, isn't approved as it now stands, or the approval stopped applying because License, sign-in trust or the public-mint acknowledgement changed.

**Fix** Open **Config → Edge mint**. A recipe shown **Needs approval** or **Changed since approval** needs **Approve…**. Check the audit log for `config.mint.invalidate`.

**Check it works** The recipe shows **Approved** and the token route returns `200`.

## Edge mint answers 500 misconfigured

**Cause** The algorithm is unsupported, the signing secret is missing, unopenable or doesn't have usage `edge-mint`, the claims template is corrupt, or `requires: licensed` is set on a product without License.

**Fix** Set the secret's usage to `edge-mint` under **Keys & secrets**, check the key matches the `alg`, and use `requires: registered` on a config-only product.

**Check it works** The token route returns `200`.

## Edge mint answers 403 forbidden

**Cause** The caller's merged payload lacks the recipe's `requiredEntitlement`, or has it as `false`, `0` or an empty string.

**Fix** Grant the entitlement through the tier or a profile.

**Check it works** The token route returns `200` for that device.

## rate_limited

**Cause** The token route allows 60 refused requests per 60 seconds per client network and 30 requests per 60 seconds per device.

**Fix** Cache the minted token until shortly before `expiresAt` and don't loop on failures.

**Check it works** The next request after the window succeeds.
