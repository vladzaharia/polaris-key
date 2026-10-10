# SP-47 React bundle diet and size budget

| Field       | Value                                                                              |
| ----------- | ---------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK usability review (2026-10-08)) |
| Size        | 0.4–0.6 engineer-weeks                                                             |
| Depends on  | none                                                                               |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                             |
| Role        | `pkey-implementer`                                                                 |
| Plan mode   | no                                                                                 |
| Gates       | `ci`                                                                               |
| Human input | none                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                          |

## Goal

React bundle diet and size budget, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (SP-47) and §10.4.

## Scope

**In:** packs, zstd-wasm and hash-wasm reached only through dynamic import; the Provider path imports no update or packs module statically; the root barrel stops re-exporting packs (they stay on `/packs`); size-limit in CI for Provider + `LicenseGate` and Provider + `useLicense`, published on the SDK page.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- No new copies (tracks.md rule 4): build on the one mechanism this package names, never beside it.

## Corrections (verified against the code)

- The package ships `tsc` output, not a bundle; the size is measured by a Vite production build of an
  app importing `dist/` (`packages/sdk-react/scripts/size-budget.mjs`), not by size-limit.
- Provider reached `hash-wasm` statically through `browser/releaseFetch.ts`, and the root barrel
  reached zstd-wasm through `packs/browserPacks.ts`; both are now `import()`.
- Measured before: +83.4 KB (use-license) and +102.4 KB (license-gate) gzip with a 69 KB `.wasm`
  emitted; after: +76.3 KB and +95.3 KB initial (+7.1 KB lazy hash-wasm chunk), no `.wasm`. The
  remaining weight is the shared core (adapters, client-core, catalog, copy), outside this scope.
- Budgets: 78 KB and 98 KB over bare React.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [x] A Vite build of Provider + `useLicense` emits no `.wasm` and inlines none.
- [x] Gzip JS over bare React stays under the budget measured in the package (today +77 KB).
- [x] CI fails over budget.
- [x] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-47 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-47 done`.
