# HA-16 Optional: release-note images hosted (`notes-image:<urlhash>` slots) and rendered from the media host at render time; the signed `notes` text is never rewritten

| Field       | Value                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 6: optional) (optional) |
| Size        | 0.4–0.6 engineer-weeks                                                                          |
| Depends on  | [HA-05](HA-05-pull-on-sync.md), [HA-07](HA-07-serve-hosted-copies.md)                           |
| Unblocks    | none                                                                                            |
| Role        | `pkey-implementer`                                                                              |
| Plan mode   | no                                                                                              |
| Gates       | THREAT-MODEL; portal e2e; feed goldens                                                          |
| Human input | none                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                       |

## Goal

Image links in release notes are pulled into hosted copies. The portal's What's New, the download page and the AltStore source render those images from the media host, or drop them, instead of mangling (`!alt`) or hotlinking them.

## Why

Notes images are mangled or hotlinked today. The notes text is inside the signed release record and cannot change ([S-20 §4.4](../../notes/S-20-hosted-assets.md#44-release-notes-docs-links-and-email) N1).

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- S-20 §4.4.
- `release/changelog.ts`, `page/model.ts` (`stripMarkdown`), `portal/components/product/WhatsNew.tsx`, `feeds/render.ts`.

## Scope

**In:**

- Extract https image links at release ingest and pull them (5 MiB cap).
- Render-time URL map.
- The portal renders `<img>` only for hosted URLs.

**Out** (and where it belongs instead):

- Rewriting signed notes (forbidden).

## Design notes

- Unhosted images render as their alt text, never as a hotlink.

## Steps

1. Extract and pull.
2. Render.

## Acceptance criteria

- [ ] A notes image appears from the media host in What's New, and the signed record bytes are unchanged (test).
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

None.

The role agent sets `--set HA-16 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-16 done`.
