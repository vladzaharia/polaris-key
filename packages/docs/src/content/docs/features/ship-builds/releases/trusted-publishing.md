---
title: "Trusted publishing"
description: "The three routes a release job calls, the publisher policy, and the token claims Polaris Key checks before it accepts a release."
type: "reference"
lastReviewed: "2026-10-16"
sidebar:
  order: 3
---

CI publishes a release without a long-lived secret in the product's repository (README §3.4, the
npm/PyPI trusted-publishing model). `pkey release publish` and the `polaris-key/publish` Action
drive the whole flow for you: see [Publishing from CI](/docs/build/ci/). Underneath, the flow is
three POSTs, all in the release namespace, so a product with Release off does not have them:

1. **`POST /<product>/release/publish/token`** with `{"token": "<GitHub Actions OIDC JWT>"}`.
   Request the OIDC token with the audience `https://key.plrs.im/<product>/release/publish` (the
   origin you call, then the product and route). If the token's claims satisfy the product's
   **publisher policy**, the answer is a `pkeyci_` token valid for 30 minutes with the policy's
   scopes. Each OIDC token can be exchanged once.
2. **`POST /<product>/release/publish/uploads`** with the `pkeyci_` token (`release:publish`) and
   `{"objects": [{"sha256": "…", "size": n}, …]}`. The answer is a one-shot `ticket`, R2
   temporary `credentials` (S3 endpoint, bucket, access key, secret, session token) that can only
   PUT and HEAD under `staging/<product>/<ticketId>/`, each object's staging `key`, whether it is
   already `present` (this product already references it, so skip the upload), and `nextSeq`
   (each deliverable's highest `seq` + 1). Upload each object that is not present as **one** PUT
   with `x-amz-checksum-sha256`; multipart is not granted.
3. **`POST /<product>/release/publish/submit`** with the token and
   `{"ticket": "…", "descriptor": {…}, "dryRun": false}`. Every `r2` location the product does
   not already reference must be an object of the ticket whose staged copy has the descriptor's
   size and SHA-256; the descriptor is then checked exactly as ingest checks it. Only when all of
   that passes is the ticket redeemed, the objects promoted into the blob store and the release
   written. `dryRun: true` stops before writing anything, and may come before the uploads: an
   object of the ticket not yet staged is judged as if it were and listed in `unverified`. A failed submit gives the ticket back,
   so you can fix an upload and submit again; a refusal carrying `"retryable": true` (a lost
   race with another writer, or a transient promote failure) may be sent again, and every
   other refusal is final. One descriptor per submit.

**The publisher policy.** A product opts in from `.pkey/release`:

```yaml title=".pkey/release"
publishing:
  trustedPublisher:
    workflow: .github/workflows/release.yml
    environment: release # the default
```

Link and resync turn that into the policy, adding the linked repository's **numeric** id and
owner id from GitHub (never from the manifest, so a recycled repository name cannot inherit the
policy). A token is accepted only when all of these hold: the `repository_id` and
`repository_owner_id` match; `job_workflow_ref` is this repository's declared workflow at the ref
that triggered the run (a reusable workflow in another repository does not count); the job runs
in the declared environment; `ref_protected` is `true`; the runner is GitHub-hosted; and the
event is `push`, `release` or `workflow_dispatch`. The last three are fixed by the platform.
`ref_protected` is true only when a branch or tag **ruleset** covers the ref, so a tag-triggered
release needs a tag ruleset, and the environment should require reviewers if not every writer
may publish.

The default scopes are `release:publish`, `release:promote` and `distribution:report`;
`release:yank`, `distribution:rollout` (the
[rollout controls](/docs/features/ship-builds/channels/rollouts/)), `distribution:feeds` and
`distribution:pr` (a GitHub token for the declared Homebrew tap or Scoop bucket, below), `distribution:listing` ([listing assets](/docs/features/ship-builds/channels/polaris-key/#listing-assets)) and `assets:write`
([hosted assets](/docs/features/ship-builds/channels/polaris-key/#hosted-assets)) are opt-in. Scopes are an operator setting, never a manifest one: in the console's
admin API an operator can read the policy (`/manage/api/products/<slug>/ci-publisher`),
claim and edit it (`PUT`, which also stops resync from changing it), and issue, list and revoke
**static** `pkeyci_` tokens for a CI that is not GitHub (`/manage/api/products/<slug>/ci-tokens`;
shown once, expiring at most 90 days out). Every one of those writes is audited.

**Pull requests to your tap or bucket.** With `distribution:pr`, the run asks
`POST /<product>/distribution/pr/github-token` with `{outlet, store?}`. The answer is a GitHub
token for the repository the outlet declares (`homebrewTap` or `scoopBucket`), never one the
caller names: Contents and Pull requests write on that one repository, for one hour, and
at most 20 requests per product per hour. It needs the GitHub App installed there with those
permissions. See [Homebrew](/docs/features/ship-builds/channels/homebrew/).

Errors use the platform's flat shape with a machine-readable `reason`
(`policy_mismatch` names the failing `claim`). The routes are in the
[route reference](/docs/reference/routes/); the security model is
`docs/security/THREAT-MODEL.md`, "Trusted publishing".
