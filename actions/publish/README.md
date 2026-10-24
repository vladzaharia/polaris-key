# polaris-key/publish

A GitHub Action that publishes a release from your CI job to Polaris Key: it matches built files against `.pkey/release`, uploads them, submits the release descriptor and then syncs the product's delivery channels.

## Permissions

The job needs:

```yaml
permissions:
  id-token: write # the Action requests the job's OIDC token
  contents: read
```

The repository stores no Polaris Key secret. The Action exchanges the job's OIDC token for a short-lived `pkeyci_` token, which the product's trusted-publisher policy must admit. If `.pkey/release` declares `releaseKeys`, add the release key as an environment secret and pass it as `release-key`; it reaches the command as `PKEY_RELEASE_KEY`, never on argv, and is never logged or sent.

## Minimal workflow

```yaml
name: Release
on:
  push:
    tags: ["v*"]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build # write files matching .pkey/release to dist/
      - uses: actions/upload-artifact@v4
        with:
          name: release-files
          path: dist
          if-no-files-found: error
  publish:
    needs: build
    runs-on: ubuntu-latest
    environment: release
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4 # the Action reads .pkey/ from the workspace
      - uses: actions/download-artifact@v4
        with:
          name: release-files
          path: dist
      - uses: vladzaharia/polaris-key/actions/publish@d49e25a51ecc70e0335075a970b2d35868ec2e38 # v0.9.3
        with:
          args: --tag ${{ github.ref_name }} --channel beta --dir dist
          release-key: ${{ secrets.PKEY_RELEASE_KEY }} # when .pkey/release declares releaseKeys
```

Replace the SHA with the commit of the release you pin, and keep the version comment beside it. Never use a moving tag. The inputs below apply from the first release after v0.9.3; an older pin keeps its old inputs.

The `build` job is an npm example: replace its install and build commands for your stack, but keep
the artifact name, the `dist` path and `needs: build` together. Files under `dist` must match the
artifact rules in `.pkey/release`.

## Inputs

Eight, and no others: `command` (default `release publish`), `args` (the command's flags, split on whitespace and newlines, quotes group, no shell), `release-key`, `content-key`, `base-url`, `working-directory`, `dry-run` and `channels` (`auto`, the default, or `none`). The product comes from `.pkey/product`. `channels: auto` runs `pkey channel sync` once after a successful app `release publish`; a pack or package publish never syncs, and a channel whose secret is not set is skipped with a warning.

Any other `with:` key fails the step before it does anything, with the flag to put in `args` instead (`Input dir was removed in 0.9. Put --dir <value> in args.`). Run another command with `command` (`command: assets push`, `command: channel sync`).

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
