---
title: "Register a product from its repo"
description: "Scaffold .pkey/ with pkey init, link the repository in the console, and resync after a change."
type: "how-to"
lastReviewed: "2026-10-16"
sidebar:
  order: 1
---

A product that keeps its manifest in its own repo is registered by linking that repo: the console reads `.pkey/` and creates the product from it.

**Requires:** the **Platform admin** role, Node 22.13 or later, a GitHub repository, and the `pkey` CLI. [Your first product](/docs/start/first-product/) installs the CLI.

## Before you start

- The [product](/docs/build/manifest/product/), [catalog](/docs/build/manifest/catalog/) and [release](/docs/build/manifest/release/) manifests say what each file holds.
- To create a product without a repo, use the **Nothing** path in [Your first product](/docs/start/first-product/).

## Steps

1. **CLI** In the repo's root, scaffold the manifest. `--modules` takes the service slugs; without it you get `license,config`.

   ```sh title="Terminal"
   pkey init --product tidewater --name "Tidewater Studio" --modules license,config
   ```

   You should see `.pkey/product.yaml` and `.pkey/schema.yaml` created. Existing files are never overwritten without `--force`.

2. **CLI** Check the manifest with the rules the platform applies.

   ```sh title="Terminal"
   pkey validate
   ```

   You should see the verdict, the services the manifest enables and any secret names it needs. Each error names its file and path. Fix every error before you push; warnings don't block a link.

3. **CLI** Commit `.pkey/` and push it to the default branch. The console reads the default branch only.

4. **Console** Open **Products → New product**, set **Start from** to **A GitHub repository**, enter the repository as `owner/repo`, and select **Link repository**.

   You should see the product's **Overview** with "Tidewater Studio is ready", its signing key id and a button that copies the public key.

5. **Console** Open **Core → Keys & secrets** and set any secret the manifest names but has no value yet. **Overview** lists them under **remaining secrets**. A secret's value is never shown again.

6. **CLI** Check the registered product.

   ```sh title="Terminal"
   pkey doctor --product tidewater
   ```

   You should see the manifest valid, discovery answering and the product's signing keys listed.

## After the first link

A push to the default branch re-reads `.pkey/` through the GitHub App's webhook. To apply it at once, open **Products**, open the row's menu and select **Resync from repo…**. The console shows what it re-applies before you confirm.

A resync updates the manifest baseline: product metadata, services, catalog shape, tiers, profiles and release settings. It leaves alone what an operator set in the console:

- secret values, which stay sealed and are carried onto every profile the manifest still lists;
- a service, fingerprint, auto-issue or licensing setting an operator changed live. **Revert to manifest** hands it back, and the next resync applies the manifest's value;
- per-license, per-device and management-state overrides.

A manifest can't replace a secret value that is already sealed. The whole push is refused, naming the key and profile. To rotate a secret, change it in the console and remove the value from the repo.

[What resync actually re-applies](/docs/operate/console/product-actions/#what-resync-actually-re-applies) lists every row.

## Services and sign-in

`.pkey/product` declares services under `modules`. Sign-in routes answer only while `identity` is enabled; an `oidc` block alone does not turn them on. The sign-in callback is `https://<host>/<product>/identity/auth/callback`. Register it at the identity provider and list it in `oidc.redirectUris`, or the Worker refuses to start the flow.

## If it isn't working

- **The GitHub App isn't installed, or the repository is private.** The message sits on the Repository field. Select **Install the GitHub App**, then link again.
- **The manifest has problems.** The callout lists each one with its file and path. Push the fix, then select **Check again**.
- **The slug is taken.** Change `product.slug` in `.pkey/product`, push, then select **Check again**. If this repository is already registered, resync that product instead.
- [Manifest validation codes](/docs/reference/validation-codes/): every error and warning `pkey validate` prints.
- [Troubleshoot your integration](/docs/build/troubleshooting/): errors from the app.

## Next steps

- [Set up your editor](/docs/build/manifest/json-schema/): completion and inline errors for `.pkey/`.
- [The .pkey/ manifest](/docs/build/manifest/): the four files and the size caps.
- [Go live](/docs/build/go-live/): pins, signing and CI before you ship.
