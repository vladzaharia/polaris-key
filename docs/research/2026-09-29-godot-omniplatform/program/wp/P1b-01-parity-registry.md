# P1b-01 Feature registry, per-SDK parity manifests and the `parity:check` gate

| Field       | Value                                                                                                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P1b: SDK parity                                                                                                                                                                                                                               |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                                                          |
| Depends on  | none                                                                                                                                                                                                                                          |
| Unblocks    | [P1b-02](P1b-02-sdk-constants.md), [P1b-03](P1b-03-http-transcripts.md), [P1b-09](P1b-09-fingerprint-storage-fixes.md), [P1b-10](P1b-10-core-caps.md), [P6-05](P6-05-kotlin-sdk.md), [X-01](X-01-dotnet-sdk.md), [X-02](X-02-tauri-plugin.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                            |
| Plan mode   | no                                                                                                                                                                                                                                            |
| Gates       | a new drift gate (`pnpm parity:check`, in CI and the green gate); a new generated docs page (AGENTS rule 3, `packages/docs/test/generated.test.ts`)                                                                                           |
| Human input | none to start; the human signs off every new `web` N/A and the list of unowned gaps in review                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                     |

## Goal

The repo has a hand-written, schema-validated feature registry (`conformance/parity/features.json`)
and one parity manifest per existing SDK (Node, React, Python, Swift). Each manifest declares every
registry id as `implemented`, `na` or `planned`. The tests that prove an `implemented` entry carry an
`@pkey-feature <id>` tag. `pnpm parity:check` fails on each condition in PARITY §3.2 and runs in CI
and the green gate. A generated docs page, `reference/parity.mdx`, renders the matrix from the
manifests under the existing freshness gate. Every ✗ and ◐ in PARITY §5 appears as a `planned` entry
that names the work package closing it, or is marked unowned.

## Why

The four SDKs agree byte for byte on the wire because of the corpus, but their feature surfaces have
drifted and nothing fails when one of them lacks a feature
([PARITY §0](../../PARITY.md#0-summary), [§5](../../PARITY.md#5-the-feature-inventory)). The
registry turns "parity" from a review comment into a build failure
([§3](../../PARITY.md#3-the-feature-registry-and-parity-manifests),
[§10](../../PARITY.md#10-effort-and-roadmap)). Every later P1b package, Godot from P1, and the
optional Kotlin, C# and Tauri work declare their progress against it
([§3.3](../../PARITY.md#33-the-wave-model-extended)).

## Read first

- `AGENTS.md` (green gate; rule 3 on generated pages) and `CLAUDE.md`.
- [PARITY §2.2](../../PARITY.md#22-typed-unsupported-here) (the reason enum),
  [§3](../../PARITY.md#3-the-feature-registry-and-parity-manifests),
  [§5](../../PARITY.md#5-the-feature-inventory),
  [§7](../../PARITY.md#7-runtime-limits-that-become-typed-nas),
  [§11](../../PARITY.md#11-open-questions) Q1.
- [notes/A2 §9](../../notes/A2-sdk-port.md#9-parity-matrix-scope-addition-a), the evidence behind the
  §5 marks.
- `packages/docs/scripts/gen-reference.mjs` (the `EMITTERS` map, `page()`, `table()`, `mdxProse()`),
  `packages/docs/test/generated.test.ts`, `packages/docs/src/content/docs/reference/index.md`.
- `packages/docs/src/content/docs/contribute/waves.md` (the drift-gate inventory table).
- `tools/package.json`, `tools/gen-mirrors.test.ts` (how tool tests run), root `package.json`
  scripts, `.github/workflows/ci.yml` (the `js` job).
- The test roots to tag: `packages/sdk-node/test`, `conformance/runners/node`,
  `packages/sdk-react/test`, `packages/client-core/test`, `sdks/python/tests`,
  `sdks/swift/Tests/PolarisKeyTests`.

## Scope

**In:**

- `conformance/parity/features.json` and `conformance/parity/features.schema.json` (JSON Schema
  2020-12, as `packages/shared-manifest/schemas/v1/` uses). Every id in PARITY §5.1–§5.7, including
  the packs, UI and commerce rows, with title, owning service, proof and allowed N/As.
- `conformance/parity/manifest.schema.json` and four manifests: `packages/sdk-node/parity.json`,
  `packages/sdk-react/parity.json` (React plus `client-core`), `sdks/python/parity.json`,
  `sdks/swift/parity.json`. If `sdks/godot` exists when you start, add `sdks/godot/parity.json`
  with every entry `planned`.
- `tools/parity-check.ts` with `tools/parity-check.test.ts`; root script
  `"parity:check": "tsx tools/parity-check.ts"`. Add `ajv` (`^8.17.1`, as shared-manifest uses) to
  `tools` if you validate with it.
- `@pkey-feature` tags on the existing tests that prove each `implemented` entry.
- An emitter `"parity.mdx"` in `gen-reference.mjs`, a row in `reference/index.md`, and the
  regenerated page.
- `pnpm parity:check` in the CI `js` job, in `AGENTS.md`'s green gate, and as a row in the
  `waves.md` drift-gate inventory. One paragraph in `contribute/waves.md` saying that a new feature
  starts with its registry entry.

**Out** (and where it belongs instead):

- Generated feature-id and reason constants in each language (→ [P1b-02](P1b-02-sdk-constants.md)).
- Enforcing `transcript` proofs (→ [P1b-03](P1b-03-http-transcripts.md) extends the checker).
- Closing any gap (→ P1b-04 to P1b-09, and the P3, P4 and P5 packages named in the manifests).
- `client.supports()` and capability telemetry (`core.caps`): no work package owns them yet. Record
  `planned` and unowned, and list it in the PR (see Hand-off).
- Kotlin, C# and Tauri manifests (→ [P6-05](P6-05-kotlin-sdk.md), [X-01](X-01-dotnet-sdk.md),
  [X-02](X-02-tauri-plugin.md)).

## Design notes

**File shapes.** Proposed; keep the names so every later package agrees.

```text
// conformance/parity/features.json
{
  "registryVersion": 1,
  "reasons": ["runtime", "outlet", "product", "dependency", "version"], // PARITY §2.2
  "sdks": [{ "id": "node", "manifest": "packages/sdk-node/parity.json" } /* react, python, swift */],
  "features": [
    {
      "id": "license.channels",
      "title": "entitledChannels()",
      "service": "license",
      "proof": [{ "kind": "unit" }], // corpus{file} | transcript | unit | generated{command} | device | snapshot
      "allowedNa": [] // e.g. { "runtime": "web", "reason": "runtime", "why": "no keyring" }
    }
  ]
}

// packages/sdk-react/parity.json
{
  "sdk": "react",
  "runtimes": ["web", "desktop-bridge"],
  "testRoots": ["packages/sdk-react/test", "packages/client-core/test", "conformance/runners/node"],
  "features": {
    "core.verify": { "status": "implemented" },
    "config.secret": { "status": "na", "runtime": "web", "reason": "runtime" },
    "core.bundle": { "status": "planned", "wp": "P1b-07" },
    "core.caps": { "status": "planned", "unowned": true, "note": "supports() has no owner yet" }
  }
}
```

- Runtime ids: `node`, `python`, `web`, `desktop-bridge`, `macos`, `ios`; later Godot's export
  targets, `android`, `jvm`, `dotnet`, `unity`, `tauri`. One trait, `headless` (Node, Python), serves
  PARITY §5.7's `ui.kit` N/A. An `allowedNa` entry names a runtime or a trait.
- A mixed entry (implemented on one runtime, N/A on another) is
  `{ "status": "implemented", "except": [{ "runtime": "web", "reason": "runtime" }] }`.
- ◐ becomes `planned` with the fixing work package. Only `implemented`, `na` and `planned` exist
  ([§3.1](../../PARITY.md#31-files)).

**Tags.** `@pkey-feature <id> [<id>…]` in a comment on or above the test: `//` in TypeScript and
Swift, `#` in Python and GDScript. A tag at the top of a file covers the whole file.

**The checker fails, one line per violation, exit 1, when:**

1. a registry id is missing from a manifest, or a manifest names an id the registry lacks;
2. an `implemented` entry has no tagged test under the manifest's `testRoots`. For each `corpus`
   proof, at least one tagged file must mention the corpus file's basename without its extension
   (`gate-matrix`), which is how every runner loads it (Swift uses
   `forResource: "gate-matrix"`);
3. an `na` or `except` names a runtime the manifest does not list, or a runtime/reason pair the
   registry does not allow;
4. a `planned` entry's `wp` is not an id in `docs/research/2026-09-29-godot-omniplatform/program/workpackages.json`,
   or that package's status is `done`. `unowned: true` with a `note` is allowed and is listed, not
   failed. If the program file is absent, skip this rule with a warning;
5. a tag names an unknown feature id.

It is read-only. PARITY §3.2 names `pnpm parity:check -- --check`; accept `--check` as a no-op alias,
because the page is written by the docs generator, not by the checker.

**Declare honestly; do not copy PARITY §5.** Its marks come from notes/A2 spot checks. For every ✓,
find the test that proves it. If none exists, add a small test or mark the entry `planned`. Known
cases to settle while writing the manifests:

- `license.channels`: PARITY says "proven by `cases.json`", but no corpus case asserts
  `entitledChannels` (the `licenseDocCases` expectations are only `{ "accept": true }`). Declare the
  proof as `unit` until a corpus case exists. Swift returns `[]` when the entitlement is absent
  (`sdks/swift/Sources/PolarisKeyLicense/LicenseClient.swift:113`); the Worker returns `["stable"]`
  (`packages/worker/src/core/entitlements.ts:109`). [P1b-07](P1b-07-license-config-release-gaps.md)
  settles it.
- React's browser adapter is cookie-session based and holds no device token
  (`packages/sdk-react/src/browser/browserAdapter.ts:1-20`), and `POST /<p>/devices/report` accepts
  only a bearer (`packages/worker/src/core/devices.ts:964`). PARITY §5 allows no `web` N/A for
  `devices.register`, `devices.report`, `license.reregister`, `core.local` or `core.bundle`. For each,
  either add an `allowedNa` with a written reason (the human signs it off in review) or mark it
  `planned` with an owner.
- No work package closes `core.caps`, React `core.local`, `identity.oidc` (Node, Python ✗; Swift ◐),
  `ui.kit` (Swift ◐), `update.driver` (Node ◐, Python ◐, React ✗) or Swift `devices.report` (◐, only
  inside sync, which P1b-07 may absorb). Mark them unowned.

**The page.** The emitter reads the JSON files directly; `gen-reference.mjs` is a dependency-free
`.mjs`, so do not import the TypeScript checker. One table per service family, one column per SDK;
cells `✓`, `N/A (web: runtime)`, `planned (P1b-07)`, `planned (unowned)`. Add an "Unowned gaps"
section. Brace-escape prose with `mdxProse` and keep the output prettier-clean: the docs package
lints `src/**/*.mdx`.

**Location.** The registry lives in `conformance/parity/`, outside `conformance/corpus/**`, so it is
not a corpus-touching package and does not take the one corpus lane (program README §5).

## Steps

1. Write both schemas and `features.json` from PARITY §5, with allowed N/As from §5 and §7.
2. Write the checker and its tests, with one failing fixture per rule.
3. Draft the four manifests. Verify each `implemented` entry in the code, then add the tags.
4. Add the emitter and the index row, then run `pnpm --filter @polaris-key/docs gen`.
5. Wire the root script, the CI step (after `pnpm test`), the `AGENTS.md` green-gate line and the
   `waves.md` row.
6. Run the green gate. List in the PR every new `web` N/A and every unowned gap.

## Acceptance criteria

- [ ] `features.json` validates against its schema and contains every id in PARITY §5.1–§5.7.
- [ ] The four manifests validate, and each lists every registry id.
- [ ] `mise exec node@22 -- pnpm parity:check` exits 0 on the branch.
- [ ] `pnpm --filter @polaris-key/tools test` has one failing fixture for each of the five rules,
      plus an `na` on a runtime the manifest does not list.
- [ ] Deleting one tag from a proving test makes `pnpm parity:check` fail (shown in the PR).
- [ ] `reference/parity.mdx` exists, is linked from `reference/index.md`, and
      `pnpm --filter @polaris-key/docs gen:check` passes.
- [ ] CI's `js` job runs `pnpm parity:check`; `AGENTS.md` and `waves.md` list it.
- [ ] Every `planned` entry names a work package or is `unowned` with a note. The PR lists the
      unowned gaps and each new `web` N/A.
- [ ] The green gate passes (`AGENTS.md`), including `pnpm format` over the new JSON.

## Verify

```sh
mise exec node@22 -- pnpm install
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/tools test
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm --filter @polaris-key/docs test
mise exec node@22 -- pnpm format
```

## Hand-off

- **Interfaces others rely on:** the file paths above; the manifest statuses and fields (`status`,
  `runtime`, `reason`, `except`, `wp`, `unowned`, `note`); the tag syntax; the reason enum; the
  checker's exit behaviour.
- [P1b-02](P1b-02-sdk-constants.md) reads `features[].id` and `reasons` to emit constants.
  [P1b-03](P1b-03-http-transcripts.md) adds `transcript`-proof enforcement to the checker.
- Every later package updates the manifests it touches (the template's acceptance line). A new SDK
  (Godot in P1-01, P6-05, X-01, X-02) starts with a manifest in which everything is `planned`.
- Give the lead the unowned list, starting with `core.caps` (`supports()` and the typed
  `Unsupported` result from PARITY §2.2), which no package owns.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1b-01 done`.
