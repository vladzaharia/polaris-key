# polaris-key/publish

A GitHub Action that publishes a release from your CI job to Polaris Key: it matches built files against `.pkey/release`, uploads them and submits the release descriptor.

## Permissions

The job needs:

```yaml
permissions:
  id-token: write # the Action requests the job's OIDC token
  contents: read
```

The repository stores no Polaris Key secret. The Action exchanges the job's OIDC token for a short-lived `pkeyci_` token, which the product's trusted-publisher policy must admit. If `.pkey/release` declares `releaseKeys`, add the release key as an environment secret and pass it as `release-key`; it is never logged or sent.

## Minimal workflow

```yaml
name: Release
on:
  push:
    tags: ["v*"]

jobs:
  publish:
    runs-on: ubuntu-latest
    environment: release
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4 # the Action reads .pkey/ from the workspace
      - uses: actions/download-artifact@v4
        with:
          path: dist # your build job's output, one subdirectory per artifact
      - uses: vladzaharia/polaris-key/actions/publish@d49e25a51ecc70e0335075a970b2d35868ec2e38 # v0.9.3
        with:
          product: your-product
          tag: ${{ github.ref_name }}
          channel: beta
          dir: dist
          release-key: ${{ secrets.PKEY_RELEASE_KEY }} # when .pkey/release declares releaseKeys
```

Replace the SHA with the commit of the release you pin, and keep the version comment beside it. Never use a moving tag.

## Inputs

The table of inputs and outputs is the generated [GitHub Action reference](https://key.plrs.im/docs/reference/github-action/).

## What it does not do

It never builds, signs binaries or uploads to stores. Run your export and vendor tools first, then this step. Polaris Key records the release, decides who may install it, serves the files and controls the rollout.

## Docs

- [Ship builds from CI](https://key.plrs.im/docs/features/ship-builds/ci/): the walkthrough, with packs, package feeds and store steps.
- [GitHub Action reference](https://key.plrs.im/docs/reference/github-action/)

## Versions

Pin by the full commit SHA of a release of this repository. The Action runs on the `node24` runtime and needs no install step.

## License

MIT. Bundled dependencies are listed in [`THIRD_PARTY_NOTICES`](https://github.com/vladzaharia/polaris-key/blob/main/actions/publish/THIRD_PARTY_NOTICES).
