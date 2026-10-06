# PS-10 `direct` shown as "Polaris Key": console and download-page labels, docs and glossary, SDK READMEs, the S-19 grant source `polaris-key`; identifiers unchanged

| Field       | Value                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------- |
| Phase       | PS: Polaris Key storefront: the Library as a distribution channel (S-21) (phase 1: substrate) |
| Size        | 0.3–0.5 engineer-weeks                                                                        |
| Depends on  | none                                                                                          |
| Unblocks    | none                                                                                          |
| Role        | `pkey-implementer`                                                                            |
| Plan mode   | no                                                                                            |
| Gates       | docs help-link drift gate; console CSP parity (label changes only)                            |
| Human input | none                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                     |

## Goal

Everywhere a person reads it, the `direct` outlet is called "Polaris Key", while every identifier (outlet id and kind, generated constants, corpus, Android flavour, Maven artifacts) stays `direct`; the planned S-19 grant source is `polaris-key`.

## Why

The owner: "`direct` really becomes `Polaris Key`" ([S-21 §6.8](../../notes/S-21-polaris-storefront.md#68-direct-becomes-polaris-key-ps-10), D9). Renaming the id is a wire change with no behavioural benefit (S-21 §7).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-21](../../notes/S-21-polaris-storefront.md): the owner-decisions block (it wins over the sections below it) and the sections in this brief's refs.
- `packages/admin/src/lib/labels.ts`; `packages/worker/src/services/distribution/page/render.ts`; the docs pages listed in S-21 §6.8; SDK READMEs; `docs/security/WIRE-CONTRACT-V4.md` §8.

## Scope

**In:**

- `OUTLET_KIND_LABELS.direct = "Polaris Key"`; subkinds "Polaris Key · via <manager>"; download page "Download from Polaris Key".
- A test that no user-facing string in the console or download page says "Direct download".
- Docs and glossary (`start/concepts.md`): "the Polaris Key outlet (id `direct`)"; WIRE-CONTRACT-V4 §8 prose sentence.
- S-19 vocabulary: [LX-08](LX-08-licensing-expand.md)'s amendment already records `polaris-key`; update `notes/S-19` prose references to the badge.

**Out** (and where it belongs instead):

- Any identifier change (plan mode, not planned; S-21 §7 lists what it would take).

## Design notes

- Obtainium's `source: "direct"` is unrelated; leave it.

## Steps

1. Re-read the S-21 sections above; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PS-10:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the gates in the header; set `--set PS-10 in-review`.

## Corrections from the code (2026-10-05, implementer)

- The download page's "Direct download" was the head of each build entry under "Other ways to
  get it" (`page/render.ts` `way()`), not a page heading. It now reads "Download from Polaris
  Key"; the primary buttons already read "Download for <platform>".
- The console renders no outlet subkind today. `outletLabel(kind, subkind)` and
  `OUTLET_SUBKIND_LABELS` (`lib/labels.ts`, covering every `OUTLET_SUBKINDS` value) give
  "Polaris Key · via Homebrew" for the first view that shows one; `outletKindLabel` takes the
  optional subkind.
- Two console empty states (Matrix, Outlets) said "the direct download"; the source-scan test
  found them and they now say "Polaris Key downloads".
- Views that show an outlet **id** (rollouts, update health, matrix cell names) keep showing the
  id (`direct`): it is the owner's identifier, not a label.
- Decided (delegated): `plans/LX-01.md` is an approved plan and stays as written; the LX-08
  amendment and the S-19 owner-decisions block (item 6) carry `polaris-key`.

## Acceptance criteria

- [ ] Label test passes; console and download-page snapshots updated.
- [ ] `check:links` passes; `pnpm gen:corpus -- --check` and `pnpm gen:constants -- --check` show no change.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test && mise exec node@22 -- pnpm gen:corpus -- --check
```

## Hand-off

S-22 adds the provenance kind `polaris-key` ("Bought on Polaris Key").

The role agent sets `--set PS-10 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PS-10 done`.
