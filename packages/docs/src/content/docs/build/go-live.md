---
title: "Go live"
description: "Pin two signing keys, sign your builds, and publish from CI before you ship."
type: "how-to"
lastReviewed: "2026-10-16"
sidebar:
  order: 9
---

An app that ships pins the keys that sign its documents, so the pins you build with are the ones you can't take back. Do these steps in order before the first release.

**Requires:** the **Platform admin** role, the `pkey` CLI, and a product that passes [Test your integration](/docs/build/test-your-integration/).

## Before you start

- A product and an app that already activates: [Your first product](/docs/start/first-product/).
- To publish from CI (steps 2 and 6), a product [registered from its repo](/docs/build/manifest/register/), with Release on and `.pkey/release`. [Release manifest](/docs/build/manifest/release/) covers it.

## Steps

1. **Console** Open **Core → Keys & secrets**. In **Signing keys**, select **Prepare signing key**, and confirm.

   You should see a second key listed as **Staged**. A new product has one signing key, and an app that pins only one can't recover if that key is revoked. `pkey sdk` warns while discovery lists only one.

2. **CLI** If you ship through Release, generate a release key. CI signs release records with it; the Worker never holds it.

   ```sh title="Terminal"
   pkey release keys generate --kid ci-2026 --out release-key.pem
   ```

   You should see the `releaseKeys` entry to paste into `.pkey/release` and the private key written to `release-key.pem`. Push the entry. Store the private key as a secret of the GitHub environment that publishes, and keep it out of the repo.

3. **CLI** Generate the config file so it pins both signing keys and, in the product's repo, the release keys from `.pkey/release`.

   ```sh title="Terminal"
   pkey sdk --lang <lang> --product <slug> --write --force
   ```

   You should see both key ids with their SHA-256 fingerprints, and the release keys instead of `Release keys: none`. Build the app from this file.

4. **Console** Compare each key in the file with **Public key** under **Core → Keys & secrets**. A pin that doesn't match is a key someone else could sign for.

   You should see each pin match a listed key.

5. **App** Sign your builds with each platform's own tools, such as Apple notarization or Authenticode. Polaris Key records what those steps produced; it doesn't sign binaries.

   You should see a signed build that opens on a clean machine without an unidentified-developer warning.

6. **CLI** Wire the publish step into your release job, with `pkey release publish` or the `polaris-key/publish` GitHub Action. Name the workflow in `publishing.trustedPublisher` in `.pkey/release`. The job exchanges its GitHub token for a short-lived token, so no secret sits in the repo. [Publishing from CI](/docs/features/ship-builds/ci/) has the workflow and the ruleset the ref needs.

   You should see the release in the console after the job runs, with each build matched to your artifact map.

7. **CLI** Check the product one last time.

   ```sh title="Terminal"
   pkey doctor --product <slug>
   ```

   You should see the manifest valid, discovery answering and two signing keys listed.

## Check it works

A build made from the new config activates a test license against production, and `pkey doctor` shows no remaining `todo` facts.

## If it isn't working

- A pin that the console doesn't list means the file came from another product or base URL. Regenerate it with `--product` and, off `key.plrs.im`, `--base-url`.
- The publish step is refused when the ref isn't protected. [Publishing from CI](/docs/features/ship-builds/ci/#before-the-first-publish) lists what GitHub must report.
- Secrets and keys (console members): staging, activating and revoking a key.
- [Troubleshoot your integration](/docs/build/troubleshooting/): errors from the app.

## Next steps

- [Publishing from CI](/docs/features/ship-builds/ci/): the workflow, dry runs and channels.
- [Going offline](/docs/features/licensing/offline/): bundles for air-gapped devices.
- [The pkey CLI](/docs/reference/cli/): every command and flag.
