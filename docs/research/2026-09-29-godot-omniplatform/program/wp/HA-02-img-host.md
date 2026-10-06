# HA-02 Image host `img.plrs.im` (`img-staging`, `img-dev`): fourth custom domain, `IMG_ORIGIN`, `core/imgHost.ts` confinement, content-addressed immutable routes and stable aliases

| Field       | Value                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 1: substrate)                                                                                              |
| Size        | 0.6–1 engineer-weeks                                                                                                                                                               |
| Depends on  | [HA-01](HA-01-hosted-asset-core.md)                                                                                                                                                |
| Unblocks    | [HA-06](HA-06-upload-paths.md), [HA-07](HA-07-serve-hosted-copies.md), [HA-12](HA-12-presentation-discovery.md)                                                                    |
| Role        | `pkey-implementer`                                                                                                                                                                 |
| Plan mode   | no                                                                                                                                                                                 |
| Gates       | wrangler config; rule 10 (OpenAPI + routeCoverage); THREAT-MODEL; workerd lane                                                                                                     |
| Human input | none: the deploy attaches img.plrs.im, img-staging.plrs.im and img-dev.plrs.im (the Worker routes create the DNS records); the plrs.im zone is in the account (checked 2026-10-06) |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                          |

## Goal

`https://img.plrs.im/<p>/a/<sha256>[/<w>.webp]` serves public hosted images with immutable caching. `/<p>/icon`, `/<p>/header` and `/<p>/screenshots/<n>` 302 to the current copy. The host is confined to these routes, sets no cookies, and refuses anything gated or not hosted.

## Why

Decision 2 gives presentation images their own cookie-less, CSP-friendly host instead of the console origin or the downloads host ([S-20 §6.5](../../notes/S-20-hosted-assets.md#65-hosts-why-a-separate-imgplrsim)).

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- S-20 §6.5.
- `packages/worker/wrangler.toml` (bytes and registry host blocks), `src/core/bytesHost.ts`, `src/core/bytesHostname.ts`, `src/core/registryHost.ts` and their tests.

## Scope

**In:**

- Routes `img.plrs.im` (`img-staging`, `img-dev`) (`custom_domain = true`) and var `IMG_ORIGIN` in prod, staging and dev. `env.ts` and `imgHostname.ts`.
- `core/imgHost.ts`: confinement, headers (`nosniff`, sniffed `Content-Type`, `Cache-Control: public, max-age=31536000, immutable` on `/a/`, `Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy: cross-origin`, `Content-Security-Policy: default-src 'none'; sandbox`), cookie stripping, rate limit `imgHost`.
- Tenancy: serve only when `<p>` holds a `hosted-asset` ref to the hash. Refuse `gated/`.
- Stable aliases with `Cache-Control: public, max-age=300`.
- OpenAPI entries and `routeCoverage` (rule 10). `docs/DEPLOYMENT.md` "Image host" section.

**Out** (and where it belongs instead):

- Rewriting consumers to these URLs (→ HA-07).

## Design notes

- The image host never carries auth code. A gated object is a 404, not a 401.
- Same Worker and same bucket: no new resources beyond the custom domain.

### As built (HA-02, corrections against the code)

- **Names.** The owner asked for `img.plrs.im`, never "media", so the hostname module is
  `core/imgHostname.ts` (not `mediaHostname.ts`), the URL helper is `imgUrl` (not `mediaUrl`), the
  rate-limit bucket is `imgHost` and the `DEPLOYMENT.md` section is "Image host".
- **`Cache-Control` on `/a/`** is `public, max-age=31536000, immutable, no-transform`: the brief's
  value plus `no-transform`, as `blobResponse` sends, so no edge recompression changes the bytes
  the hash names.
- **Images only.** `IMG_HOST_TYPES` is `sniff.ts`'s `IMAGE_TYPES` (PNG, JPEG, WebP, GIF, AVIF).
  Video waits for HA-17. Tenancy is also narrowed to image slots: a `hosted-asset` ref held
  through a `release-file` slot is never served here, even when its bytes are a PNG.
- **Variants.** The host reads `variants_json` entries of the shape S-20 §6.2 names,
  `{w, format: "webp", sha256, size}`, and serves one only when the same slot (`ref_id`
  `<slot>@<locale>`) also holds a `hosted-asset` ref to the variant's object. HA-03 must write
  exactly that.
- **Aliases** read the every-locale (`''`) row; `/icon` is `presentation.icon`, else
  `listing.icon`. A locale-aware alias is a follow-up if a consumer needs one.
- **Cost.** The bytes of an `/a/` answer are kept in the Cache API under their hash; the tenancy
  check runs on every request and is never cached. The `imgHost` limit (600 a minute per product
  and IP) counts cache misses only and fails open.
- **Platform settings.** `IMG_ORIGIN` joins the origin deny-list (`settings/rules.ts`), the
  settings coverage table and the console's read-only Platform → Settings inventory.

## Steps

1. Wrangler and env.
2. Confinement and headers with tests modelled on `bytesHost.test.ts`.
3. Routes, OpenAPI, routeCoverage.

## Acceptance criteria

- [x] Every non-image route on the image host is a 404, and the image routes are 404 on other hosts (test).
- [x] Headers are pinned by test, and no response sets a cookie.
- [x] A hash held only by another product is a 404 (test).
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

HA-07 and HA-12 build URLs with an `imgUrl(env, product, sha256, w?)` helper exported from Core (`core/imgHostname.ts`, re-exported by `core/imgHost.ts`). It answers `null` when `IMG_ORIGIN` is unset or an argument could never be served.

The role agent sets `--set HA-02 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-02 done`.
