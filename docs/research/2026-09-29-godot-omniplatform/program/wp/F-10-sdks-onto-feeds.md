# F-10 Our SDKs onto the feeds: the root `.pkey/`, release workflows, Kotlin `maven-publish`, Swift signing and the first OCI image

| Field       | Value                                                                                                                                                                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-1)                                                                                                                                                                                                                                                                                                           |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                                                                                                                                                                              |
| Depends on  | [F-04](F-04-npm-feed.md), [F-05](F-05-pypi-feed.md), [F-06](F-06-swift-registry.md), [F-07](F-07-maven-feed.md), [F-08](F-08-oci-registry.md), [F-09](F-09-godot-feed.md)                                                                                                                                                                         |
| Unblocks    | none                                                                                                                                                                                                                                                                                                                                              |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                |
| Plan mode   | no: follows [`plans/F-01.md`](../plans/F-01.md) §5                                                                                                                                                                                                                                                                                                |
| Gates       | Action-bundle drift (workflows use the committed Action); docs links (`build/install-from-feeds.md`); CI (new `release-kotlin.yml`, changed release workflows)                                                                                                                                                                                    |
| Human input | trusted-publisher registration of `vladzaharia/polaris-key` for the `polaris-key` system product in each environment; the Swift signing certificate and key as the CI secrets `SWIFT_REGISTRY_SIGNING_KEY`, `SWIFT_REGISTRY_SIGNING_CERT` and `SWIFT_REGISTRY_CERT_CHAIN` (the owner provides them later; the Swift job fails clearly until then) |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                         |

## Goal

Every SDK this repository ships is published to its feed on `pkg.plrs.im` by CI, through `pkey
release publish` and trusted publishing under the `polaris-key` system product:

- npm: client-core, node, react, manifest, jws, protocol, catalog and cli (plus brand and
  zstd-wasm);
- PyPI: `polaris-key`;
- Swift: `polaris-key.PolarisKey`, signed;
- Maven: `im.plrs.key:polaris-key-platform` and `im.plrs.key:polaris-key-godot`;
- Godot: `polaris_key`;
- OCI: `polaris-key/pkey`.

Publishing to GitHub Packages and to PyPI stops (owner decision: feeds only). An adopter page
shows how to install each one.

## Why

The SDKs ship four different ways today, and the Kotlin AAR not at all ([S-12 §6.4](../../notes/S-12-package-feeds.md#64-how-todays-sdks-get-onto-the-feeds)).
The feeds exist to host them.

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §5, §7.2.
- `.github/workflows/{release,release-python,release-swift,release-godot}.yml`,
  `sdks/kotlin/{build.gradle.kts,settings.gradle.kts,platform/build.gradle.kts}`,
  `sdks/godot/native/android/`, `sdks/swift/Package.swift`, `actions/publish/`.

## Scope

**In:**

- **The root `.pkey/`** (`product`, `release`) declaring the system product's package deliverables
  (plan §5.1), validated by `pkey validate`.
- **`release.yml`:** `pnpm pack` into `dist-pkg/`, then publish each package. **Remove**
  `changeset publish` to GitHub Packages.
- **`release-python.yml`:** publish the wheel and sdist. **Remove** the PyPI publish step.
- **`release-swift.yml`:** a macOS job that checks the signing secrets (§5.3's error text), runs
  `swift package-registry publish --dry-run` with the signing flags, publishes, and deletes the key
  files in an `always()` step.
- **Kotlin:** `maven-publish` on `:platform` and `:godot` with sources jar, POM and `.module`; a
  `build/repo` local repository; the new `release-kotlin.yml`.
- **`release-godot.yml`:** publish the canonical zip.
- **OCI:** a `Dockerfile` for the `pkey` image, multi-arch `buildx` to an OCI layout, and publish.
- **Docs:** `build/install-from-feeds.md`; each SDK README's install section.

**Out:**

- Feeds themselves (→ F-04 to F-09).
- Publishing to any public registry (owner decision).
- Claiming public names (plan Q2, a human action).

## Design notes

- Workflows use the committed `polaris-key/publish` Action, so CLI changes reach CI only through
  the Action bundle.
- The Swift job never falls back to unsigned. Without the secrets it fails with the exact message
  in plan §5.3.
- One ecosystem may land at a time, npm first, each once its feed's matrix is green.

## Steps

1. Root `.pkey/` and the bootstrap check against staging.
2. npm, then PyPI, Godot, Kotlin, OCI and Swift workflows, each verified on staging with a
   pre-release version.
3. Remove the old publish steps; the docs page; the READMEs.

## Acceptance criteria

- [ ] A tagged pre-release of each SDK appears on its staging feed, and its client installs it
      using the page's snippet.
- [ ] No workflow publishes to GitHub Packages, PyPI, npmjs or Maven Central.
- [ ] The Swift job fails with the documented message when a secret is missing.
- [ ] `bundle:action -- --check` and `check:links` pass. The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli bundle:action -- --check
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
( cd sdks/kotlin && ./gradlew publishAllPublicationsToLocalRepository )
mise exec node@22 -- node packages/cli/dist/pkey.mjs validate
```

## Hand-off

- Adopters install from the feeds.
- F-21 later adds tokens to the same snippets.

The role agent sets `--set F-10 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-10 done`.
