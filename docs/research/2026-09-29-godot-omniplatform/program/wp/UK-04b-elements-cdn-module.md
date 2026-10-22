# UK-04b Elements CDN module `key.plrs.im/elements/<major>/pk.js` and the npm publish

| Field       | Value                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must) |
| Size        | 0.1 engineer-weeks                                                           |
| Depends on  | [UK-04](UK-04-web-components.md)                                             |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                       |
| Role        | `pkey-sdk-porter`                                                            |
| Plan mode   | no                                                                           |
| Gates       | `modernity-lint`, `rule-10`, `threat-model`, `docs-links`                    |
| Human input | none                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                    |

## Split 2026-10-22 (triage)

Filed from [UK-04](UK-04-web-components.md) by the program triage (`/Users/vlad/Repos/pk-wt/_lead/triage-2026-10-22.md`, size 3–4 h). UK-04 carries what is on staging; this package carries the rest.

On staging already: UK-04 on staging: 560 baselines, React to elements parity 558/560, the BUILT re-review `ux-review-2.md`, `elements.mdx`. The `--live` sample rides KX-EL-DRIVE.

## Goal

Elements CDN module `key.plrs.im/elements/<major>/pk.js` and the npm publish. Done when every acceptance criterion holds and the green gate passes.

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- The parent brief [UK-04](UK-04-web-components.md), its Progress and Split notes.

## Scope

**In:**

- The CDN module of UK-04: a Worker route serving `key.plrs.im/elements/<major>/pk.js`, its OpenAPI entry and `routeCoverage` row (rule 10), the assemble step, and `release.yaml` / the npm publish (the package is private at 0.0.0). Optional: ratchet the React size budget 71.2 KB to 68.5 KB (measured 68.1). Nothing in the graph depends on it.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and everything UK-04 already shipped.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] `GET /elements/<major>/pk.js` serves the built module with immutable caching and a pinned CSP story
- [ ] OpenAPI entry and `routeCoverage` row (rule 10); `assemble` carries the file
- [ ] `@polaris-key/elements` is publishable (version, `release.yaml`)
- [ ] `elements.mdx` states the CDN URL
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-04b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-04b done`.

## Progress (2026-10-22)

Built on `wp/UK-04b-elements-cdn`; merges after v0.9.15. Route `core/elements.ts` (`/elements/<major|version>/<file>`), assets by `assemble` via `bundle:cdn`; the floating major `pk.js` is a shim onto the exact version. `elements` is a reserved slug. `@polaris-key/elements` is public, `npm.elements` in release.yaml, publish tier 5 with cli. Threat-model section "The Elements CDN module". Known residual: only the current version is in the assets root, so older pinned URLs 404 after the next release (an archive is a follow-up). Release flow note: the first publish needs a deploy to register `npm.elements`. Ingest golden 11a/11b re-captured (one more deliverable row). The React size ratchet was not done.
