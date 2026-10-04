# F-05 PyPI feed: PEP 691 JSON, PEP 658/714 metadata, PEP 592 yank and the inert HTML fallback

| Field       | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-1)                                |
| Size        | 1–1.5 engineer-weeks                                                   |
| Depends on  | [F-02](F-02-registry-host.md), [F-03](F-03-package-releases.md)        |
| Unblocks    | [F-10](F-10-sdks-onto-feeds.md), [F-12](F-12-console-feed-settings.md) |
| Role        | `pkey-implementer`                                                     |
| Plan mode   | no                                                                     |
| Gates       | rule 10 (its `REGISTRY_PATHS` rows and spec entries)                   |
| Human input | none                                                                   |
| Repo        | `vladzaharia/polaris-key`                                              |

## Goal

The PyPI feed serves every package the owner's feed holds, rendered by a `RegistryRenderer` in
`services/distribution/registry/pypi/`, with the endpoints of
[plan §6.8](../plans/F-01.md#68-per-ecosystem-read-endpoints-and-the-real-client-matrices). The inert HTML fallback is served only when `Accept` lacks the JSON type. Its
real-client matrix runs green in `registry-clients.yml`.

## Why

pip and uv refuse plain `application/json`; the exact PEP 691 type is required. pip before 22.2 needs HTML, which is the host's single HTML answer.

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.2, §6.5–§6.8; [S-12 §4.1](../../notes/S-12-package-feeds.md#41-summary-table) (the PyPI row and its notes).
- The Simple Repository API, PEPs 691, 658, 714 and 592, pip's `collector.py`, and uv's `registry_client.rs` ([S-12 §13](../../notes/S-12-package-feeds.md#13-sources)).
- F-02's `RegistryRenderer` and the harness; F-03's `packageVersions` hook and the PyPI extractor.

## Scope

**In:**

- `simple/` and `simple/<normalised>/` in JSON (API 1.1) and HTML; 301 normalisation and trailing-slash redirects; files under `files/<sha256>/<filename>`; `<file>.metadata` (PEP 658); `yanked` with a reason (PEP 592).
- Its `REGISTRY_PATHS` rows and the OpenAPI entries (rule 10).
- Golden-file tests for every rendered document, from a fixture with a stable and a beta version,
  one yanked version and one deprecated where the protocol allows.
- Its section of `services/distribution/package-feeds.md` and its snippet input for F-12.

**Out:**

- Auth challenges beyond the tier-1 refusal (→ F-21).
- Native publish (→ F-22).
- Settings UI (→ [F-12](F-12-console-feed-settings.md)).

## Design notes

- The HTML page escapes every value, has no script, form or style, and passes `inertDocumentPolicy`. The `htmlFallback` setting off answers 406.
- Names are compared after PEP 503 normalisation. Fragment hashes are for corruption only.

## Steps

1. The renderer and its golden files.
2. The routes, headers, negotiation and errors.
3. The client matrix job; then the docs.

## Acceptance criteria

- [ ] Matrix green: pip current and 22.2, uv with `explicit = true`, Poetry 2.
- [ ] Yank, deprecate and channel-tag behaviour match plan §6.7 and the protocol.
- [ ] The headers of plan §6.7 are on every answer. Nothing outside `REGISTRY_HOST_TYPES` is served.
- [ ] `routeCoverage` passes. The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry/pypi routeCoverage
gh workflow run registry-clients.yml -f ecosystem=pypi
```

## Hand-off

- F-10 publishes our PyPI packages to this feed.
- F-12 renders this feed's setup snippets and settings panel.

The role agent sets `--set F-05 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-05 done`.
