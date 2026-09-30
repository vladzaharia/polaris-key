# P6-04 Optional: Polaris-hosted, channel-pinned web builds

| Field       | Value                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P6: Commerce, ops, web (optional)                                                                                                                                                      |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                   |
| Depends on  | [P2-01](P2-01-blob-store.md), [P0-05](P0-05-cors.md)                                                                                                                                   |
| Unblocks    | none                                                                                                                                                                                   |
| Role        | `pkey-implementer`                                                                                                                                                                     |
| Plan mode   | no                                                                                                                                                                                     |
| Gates       | none listed. In practice: rule 10 or a narrative-only decision for the new route kind, a `wrangler.toml` route on the byte domain, and a threat-model note on hosting third-party code |
| Human input | none listed. In practice: DNS and a Worker route for the web-hosting hostname on the separate registrable domain P2-01 set up                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                              |

This is a kickoff brief for an optional package. The implementer turns it into a short plan in the
PR description before writing code.

## Goal

A product can publish a Godot (or any) web export as an app release, and players open
`https://<bytes-domain>/<product>/<channel>/` to get the build that channel points at. Every build is
also reachable, immutable, at `/<product>/b/<buildId>/`. Files come from R2 with the right content
types and precompressed Brotli, and cross-origin isolation headers are sent only for threaded
builds. Moving the channel pointer moves the players on their next load.

## Why

- CORS is the must-have for web; hosting is optional but "worthwhile for channel-pinned web builds"
  (decision 9 in [§11](../../README.md#11-decisions-needed)).
- Workers static assets cap files at 25 MiB, too small for Godot's `.wasm` and `.pck`, so hosting
  must be R2 behind a thin Worker route, on a separate registrable domain so it never shares a site
  with the console's cookies ([§3.11](../../README.md#311-web), [§3.5](../../README.md#35-storage-and-byte-delivery)).

## Read first

- `AGENTS.md`; the hand-offs of P2-01 (blob store, byte domain, bucket locks) and P0-05 (CORS
  allowlist); P2-04/P2-05 for how a web artifact (`platform: web`, `arch: wasm32`) is recorded and
  how channel pointers resolve.
- [README §3.11](../../README.md#311-web) and [§4.6](../../README.md#46-web); notes/E3 §C1–§C2
  (Godot web export requirements, hosting) and §E2.
- `packages/worker/src/router.ts` (route kinds) and `test/routeCoverage.test.ts`.

## Scope

**In:**

- CI publishes the unpacked web export as content-addressed blobs plus a web manifest (path →
  sha256, size, content type, encoding), recorded as an artifact of the app release (proposed role
  `web-manifest`).
- A byte-domain route: `/<product>/b/<buildId>/<path>` immutable
  (`Cache-Control: public, max-age=31536000, immutable`); `/<product>/<channel>/<path>` resolved
  through the channel pointer with a short TTL and an `ETag` equal to the file's hash.
- Content types (`application/wasm`, `application/octet-stream` for `.pck`), `Content-Encoding: br`
  when a precompressed variant exists and the client accepts it, `Vary: Accept-Encoding`.
- COOP/COEP/CORP only when the manifest marks the build threaded; none for single-threaded builds.
- A per-channel service-worker scope, so a Godot PWA export updates when the pointer moves.
- Tests with a fake R2 and a fake release catalog; operator docs.

**Out** (and where it belongs instead):

- CORS itself (→ [P0-05](P0-05-cors.md)); the blob store and domain (→ [P2-01](P2-01-blob-store.md)).
- Pack delivery to web builds (the `web` transport; P4-05 and the packs work).
- Compression Dictionary Transport for web deltas (→ P4-18).
- A download page "Play now" button (P2b-06 may link to this).

## Design notes

- **Where it lives.** Byte serving moved to distribution in P2b-04, and `web` is an outlet. Put the
  route in distribution if P2b-04 has landed; P2b-04 is not a declared dependency, so check.
- **Hosting is serving product code** from a Polaris-controlled domain. Keep it off every console or
  API hostname, send no cookies, and set a strict `Content-Security-Policy` only if it does not break
  Godot's loader (test it).
- **Channel paths are not immutable.** Only `/b/<buildId>/` gets the one-year cache.
- **Open questions for the plan:** the exact public URL shape; whether `/<channel>/` serves files
  directly or redirects to `/b/<buildId>/` (a redirect breaks a per-channel service-worker scope);
  and S-02's findings on Range and cold misses.

## Steps

1. Write the plan in the PR description (URL shape, pointer resolution, headers).
2. CI side: web manifest and blob upload in the publish flow.
3. The route, headers and tests; route-coverage decision.
4. A Godot 4.7 single-threaded web export served end to end from a dev deployment.

## Acceptance criteria

- [ ] Tests cover: immutable build paths; channel paths follow the pointer and revalidate by `ETag`;
      `.wasm` served as `application/wasm`; Brotli chosen only when accepted; isolation headers only
      for threaded builds; unknown paths 404.
- [ ] A real Godot web export loads from a dev deployment through a channel URL, and moving the
      pointer serves the new build on reload (recorded in the PR).
- [ ] Route coverage and generated pages are fresh.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- webHosting routeCoverage
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
```

## Hand-off

- The hosted channel URL per product, which the download page and store listings can link to.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P6-04 done`.
