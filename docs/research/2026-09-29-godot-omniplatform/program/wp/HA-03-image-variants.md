# HA-03 Image variant ladder at ingest through the Images binding (WebP, fixed widths, never upscale), with an original-only fallback

| Field       | Value                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 1: substrate)                                 |
| Size        | 0.5–0.8 engineer-weeks                                                                                                |
| Depends on  | [HA-01](HA-01-hosted-asset-core.md)                                                                                   |
| Unblocks    | [HA-07](HA-07-serve-hosted-copies.md)                                                                                 |
| Role        | `pkey-implementer`                                                                                                    |
| Plan mode   | no                                                                                                                    |
| Gates       | wrangler config; workerd lane; THREAT-MODEL                                                                           |
| Human input | the Images binding enabled for the Worker on the Cloudflare account (free tier: 5,000 unique transformations a month) |
| Repo        | `vladzaharia/polaris-key`                                                                                             |

## Goal

Each image ingest also writes a fixed WebP width ladder: icon 64/128/256/512/1024, header 640/1280/1920, screenshots 480/960/1920, never upscaled. Each variant is content-addressed and recorded in `variants_json`. Without the binding, or on error 9422, there are no variants and nothing fails.

## Why

Consumers need sized images. Generating them once at ingest bounds the cost, against Cloudflare's unique-transformation billing, and keeps Images off the request path ([S-20 §6.6](../../notes/S-20-hosted-assets.md#66-image-processing-ha-03)).

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- S-20 §6.6.
- Cloudflare Images binding docs (cited in S-20 §12).

## Scope

**In:**

- `images` binding in `wrangler.toml` (all envs; not in `env.test`).
- Ladder generation in `ingest` after the original is stored. A `hosted-asset` ref for each variant.
- Fallback paths and tests with a stub binding and with none.

**Out** (and where it belongs instead):

- On-the-fly transforms (rejected by decision 4). Store-exact art (stays in A-18d's CLI).

## Design notes

- Ladder widths are code constants per slot family.
- Variants inherit the original's slot and are dropped with it.

## Steps

1. Binding.
2. Ladder.
3. Tests.

## Acceptance criteria

- [ ] A 512 px icon yields the 64, 128, 256 and 512 variants, and no 1024 (test).
- [ ] With no binding, `variants_json` is `[]` and the ingest succeeds (test).
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

HA-07 and HA-12 choose variants from `variants_json`.

The role agent sets `--set HA-03 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-03 done`.
