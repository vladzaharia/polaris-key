# P0-06 List and manage devices product-wide, not only per licence

| Field       | Value                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality                                                                                                |
| Size        | 0.25–0.5 engineer-weeks                                                                                                                 |
| Depends on  | none                                                                                                                                    |
| Unblocks    | none                                                                                                                                    |
| Role        | `pkey-implementer`                                                                                                                      |
| Plan mode   | no                                                                                                                                      |
| Gates       | worker + admin tests; console help-link drift gate (`docsLinks.test.ts`); docs `check:links` (rule 10 does not apply, see Design notes) |
| Human input | none                                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                                               |

## Goal

An operator can see, filter and act on every device of a product, including devices that hold no
licence (`open` or `requires-identity` registration), from a new **Platform → Devices** tab in the
console, backed by product-scoped admin endpoints. A free game's devices are no longer invisible.

## Why

Devices are listed only under a licence: the console calls
`/manage/api/products/<slug>/license/licenses/<id>/devices` (`packages/admin/src/api.ts:899-918`),
served by `packages/worker/src/services/license/admin/devices.ts:27-58`, which reads
`listDevicesByLicense` (`packages/worker/src/repo.ts:969-979`). A licence-free device is stored
with `license_id = ''` (`NO_LICENSE_ID`, `packages/worker/src/core/devices.ts:175`) and nothing
lists it; `listDevicesByProduct` (`packages/worker/src/admin/repo.ts:189-194`) is used only by
product delete. Report [§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot)
issue #12 and [§6.2](../../README.md#62-administrator-operator) item 5 ("Devices, product-wide");
[notes/A3 §2.4](../../notes/A3-admin-dx.md#24-what-an-omni-platform-game-needs-in-the-console) item 9.

## Read first

- `AGENTS.md` (rule 4: "device", not "machine"; rule 7 and `docs/PRIVACY.md`).
- `packages/worker/src/admin/api.ts:75-196` (`handleProductScoped`: where Core per-product
  resources such as `secrets`, `services`, `bundles`, `activity` are dispatched).
- `packages/worker/src/services/license/admin/devices.ts` (list, deauthorize, fingerprint reset:
  logic to reuse, not copy).
- `packages/worker/src/core/devices.ts` (`NO_LICENSE_ID`, seat release), `core/data.ts`
  (`getFingerprint`, `getDeviceFacts`, `setDeviceStatus`, `clearFingerprint`).
- `packages/worker/migrations/0007_backend_contracts.sql:43-44` (`idx_devices_status` on
  `(product, status, last_seen DESC)`).
- Console: `packages/admin/src/route.ts:33-52,103-130` (`Tab`, `SECTIONS`),
  `packages/admin/src/views/licenses/DevicesSection.tsx`, `packages/admin/src/lib/docsLinks.ts`.
- `packages/docs/src/content/docs/admin/licenses-and-devices.md`.

## Scope

**In:**

- `GET /manage/api/products/<slug>/devices` — a Core per-product resource (devices exist for a
  product running no service). Query: `status` (`authorized` default, `deauthorized`, `all`),
  `platform`, `licensed` (`true` | `false`), `q` (device-id or label prefix), `limit` (1–200,
  default 50), `cursor` (opaque keyset over `last_seen DESC, device_id`). Response
  `{ devices: DeviceSummary[], nextCursor: string | null }` where `DeviceSummary` is the licence
  view's shape without `fingerprint`/`facts`, plus `licenseId` (`null` for licence-free) and
  `seatNo`.
- `GET …/devices/summary`: counts by `status`, `platform`, `arch`, licensed vs licence-free,
  `sdk_name`, and the top 20 `app_version`s among authorised devices.
- `GET …/devices/<deviceId>`: one device with `fingerprint` and `facts` (the licence view's detail).
- `POST …/devices/<deviceId>/deauthorize` and `POST …/devices/<deviceId>/fingerprint/reset`:
  the same effects and audit events (`device.deauthorize`, `device.fingerprint.reset`) as the
  licence-scoped routes, extracted into one shared helper both call.
- Console: a **Devices** tab in the Platform section (never hidden by enablement), a table with the
  filters above, summary chips, a detail drawer, and the two actions; help link to
  `/docs/admin/licenses-and-devices/`.

**Out** (and where it belongs instead):

- Breakdowns by outlet, engine and channel: the report keys do not exist yet (→ P1-05 adds
  `engine`/`outlet`; P2b-\* add outlet data).
- Normalising platform and arch values across SDKs (→ P1b-04, `headers.json`).
- Bulk actions, CSV export, dormant-device sweeps.
- Any change to the licence-scoped endpoints' behaviour.

## Design notes

- **Rule 10 does not apply.** `/manage/api/*` is the `adminApi` route kind, listed in
  `NARRATIVE_ONLY` (`packages/worker/test/routeCoverage.test.ts:28-44`); the admin API is
  documented on the docs site, not in the OpenAPI spec. The graph lists `rule-10` for this
  package; the applicable gates are the console help-link table and the docs link check.
- **No N+1.** The licence list loads fingerprint and facts per device
  (`license/admin/devices.ts:38-55`). The product list must not: summaries only, detail on demand.
- **Keyset pagination** on `(last_seen DESC, device_id)` uses `idx_devices_status`. `status=all`
  runs two ranges or a plain scan; document the cost. `summary` is `GROUP BY` over one product;
  fine at today's sizes, note it for large free games.
- **Deauthorize for a licence-free device** marks it `deauthorized`, deletes its token record
  (`deleteTokenRecord`) and releases nothing (it holds no seat). Under `open` registration the
  device can register again; the console says so next to the action.
- The endpoints live in `packages/worker/src/admin/handlers/devices.ts` (new) and are dispatched
  from `handleProductScoped` beside `secrets`/`services`. They read and write through `core/data.ts`,
  never through License's admin module (service boundary: core may not import a service).
- **Privacy.** Only data already shown per licence is shown; raw hardware values do not exist
  server-side (rule 7). Label the list "last seen", not "online".
- The console `Tab` union gains `devices`; `SECTIONS[platform].items` gains
  `{ tab: "devices", label: "Devices", docs: "/docs/admin/licenses-and-devices/" }`. Help links
  must match `^/docs/([a-z0-9-]+/)*$` (`packages/worker/test/docsLinks.test.ts`), so no anchors;
  the link test only runs once the docs site is built (it reads `docs/dist/docs-slugs.json`).

## Steps

1. Extract the deauthorize and fingerprint-reset effects from `license/admin/devices.ts` into a
   core helper; keep the licence routes calling it.
2. Add the repository queries (paged list, summary, one device) next to `listDevicesByProduct`.
3. Add `admin/handlers/devices.ts` and the dispatch branch; tests in `test/admin.test.ts` or a new
   `test/adminDevices.test.ts`.
4. Console: API client methods, `Devices` view, route entry, tests (`packages/admin/test/`).
5. Docs: a "Devices, product-wide" section in `admin/licenses-and-devices.md` and a line in
   `admin/console-tour.md`.

## Acceptance criteria

- [x] Worker test: a product with two licensed devices and three licence-free devices lists all
      five; `licensed=false` lists three with `licenseId: null`.
- [x] Worker test: paging with `limit=2` returns every device exactly once across pages.
- [x] Worker test: deauthorizing a licence-free device through the product route sets
      `deauthorized`, removes its token record and writes an audit row; the licence route still
      refuses a device that belongs to another licence (unchanged behaviour).
- [x] Worker test: the summary counts match the fixture; a non-admin session gets 403.
- [x] Admin test: the Platform section shows **Devices** even when License is disabled.
- [x] `packages/worker/test/docsLinks.test.ts` and `pnpm --filter @polaris-key/docs check:links` pass.
- [x] The green gate passes (`AGENTS.md`). Python and Swift suites not run: no SDK, wire or corpus file changed.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- admin docsLinks
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build
mise exec node@22 -- pnpm --filter @polaris-key/docs build && mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

P1-05 adds `engine`/`outlet` report keys; its brief extends `DeviceSummary` and the summary
endpoint with those columns rather than adding new endpoints. P2b-06's distribution matrix and
P6-03's update funnel can link to `#/p/<slug>/devices` with filters. When done:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-06 done`.
