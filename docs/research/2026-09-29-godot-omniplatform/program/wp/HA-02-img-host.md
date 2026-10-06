# HA-02 Image host `img.plrs.im` (`img-staging`, `img-dev`): fourth custom domain, `IMG_ORIGIN`, `core/imgHost.ts` confinement, content-addressed immutable routes and stable aliases

| Field       | Value                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 1: substrate)                                                     |
| Size        | 0.6–1 engineer-weeks                                                                                                                      |
| Depends on  | [HA-01](HA-01-hosted-asset-core.md)                                                                                                       |
| Unblocks    | [HA-06](HA-06-upload-paths.md), [HA-07](HA-07-serve-hosted-copies.md), [HA-12](HA-12-presentation-discovery.md)                           |
| Role        | `pkey-implementer`                                                                                                                        |
| Plan mode   | no                                                                                                                                        |
| Gates       | wrangler config; rule 10 (OpenAPI + routeCoverage); THREAT-MODEL; workerd lane                                                            |
| Human input | a deploy that attaches the custom domains img.plrs.im, img-staging.plrs.im and img-dev.plrs.im (the Worker routes create the DNS records) |
| Repo        | `vladzaharia/polaris-key`                                                                                                                 |

## Goal

`https://img.plrs.im/<p>/a/<sha256>[/<w>.webp]` serves public hosted images with immutable caching. `/<p>/icon`, `/<p>/header` and `/<p>/screenshots/<n>` 302 to the current copy. The host is confined to these routes, sets no cookies, and refuses anything gated or not hosted.

## Why

Decision 2 gives presentation media their own cookie-less, CSP-friendly host instead of the console origin or the downloads host ([S-20 §6.5](../../notes/S-20-hosted-assets.md#65-hosts-why-a-separate-mediaplrsim)).

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- S-20 §6.5.
- `packages/worker/wrangler.toml` (bytes and registry host blocks), `src/core/bytesHost.ts`, `src/core/bytesHostname.ts`, `src/core/registryHost.ts` and their tests.

## Scope

**In:**

- Routes `img.plrs.im` (`img-staging`, `img-dev`) (`custom_domain = true`) and var `IMG_ORIGIN` in prod, staging and dev. `env.ts` and `mediaHostname.ts`.
- `core/imgHost.ts`: confinement, headers (`nosniff`, sniffed `Content-Type`, `Cache-Control: public, max-age=31536000, immutable` on `/a/`, `Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy: cross-origin`, `Content-Security-Policy: default-src 'none'; sandbox`), cookie stripping, rate limit `media`.
- Tenancy: serve only when `<p>` holds a `hosted-asset` ref to the hash. Refuse `gated/`.
- Stable aliases with `Cache-Control: public, max-age=300`.
- OpenAPI entries and `routeCoverage` (rule 10). `docs/DEPLOYMENT.md` media-host section.

**Out** (and where it belongs instead):

- Rewriting consumers to these URLs (→ HA-07).

## Design notes

- The media host never carries auth code. A gated object is a 404, not a 401.
- Same Worker and same bucket: no new resources beyond the custom domain.

## Steps

1. Wrangler and env.
2. Confinement and headers with tests modelled on `bytesHost.test.ts`.
3. Routes, OpenAPI, routeCoverage.

## Acceptance criteria

- [ ] Every non-media route on the media host is a 404, and the media routes are 404 on other hosts (test).
- [ ] Headers are pinned by test, and no response sets a cookie.
- [ ] A hash held only by another product is a 404 (test).
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

HA-07 and HA-12 build URLs with a `mediaUrl(product, sha256, w?)` helper exported from Core.

The role agent sets `--set HA-02 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-02 done`.
